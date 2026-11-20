import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { getCollections, withDatabaseTransaction } from "./db.js";

export const paymentProjection = Object.fromEntries([
  "_id", "bookingId", "serviceTitle", "customerName", "customerEmail", "technicianName",
  "technicianEmail", "amount", "currency", "transactionId", "stripeSessionId",
  "paymentStatus", "paidAt", "verified", "verificationSource", "testMode",
].map(field => [field, 1]));

export function verifiedPayment(record) {
  return record.verified === true && record.verificationSource === "stripe-webhook"
    && record.testMode === true && record.paymentStatus === "paid" && record.currency === "usd"
    && Number.isFinite(record.amount) && record.amount > 0
    && typeof record.stripeSessionId === "string" && record.stripeSessionId.startsWith("cs_test_")
    && typeof record.transactionId === "string" && record.transactionId.startsWith("pi_");
}
export function paymentReport(records = []) {
  const total = records.filter(verifiedPayment).reduce((sum, record) => sum + Math.round(record.amount * 100), 0);
  return { records, verificationAvailable: true,
    revenue: total ? [{ currency: "usd", amount: total / 100 }] : [],
    dependency: "Only verified Stripe Test Mode payments are counted. Test payments do not move real money." };
}
export function minorAmount(value) {
  const cents = Math.round(value * 100);
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(cents)
    || cents < 50 || cents > 99999999 || Math.abs(value * 100 - cents) > 0.00001) {
    throw Object.assign(new Error("The final amount must be a valid USD amount of at least $0.50."), { status: 400 });
  }
  return cents;
}
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key?.startsWith("sk_test_") || !process.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
    throw Object.assign(new Error("Stripe Test Mode is not configured yet."), { status: 503 });
  }
  return new Stripe(key, { timeout: 10000, maxNetworkRetries: 1 });
}
export async function paymentIndexesReady() {
  const { paymentsCollection } = getCollections();
  try {
    const indexes = await paymentsCollection.listIndexes().toArray();
    return ["bookingId", "stripeSessionId", "transactionId"].every(field => indexes.some(index =>
      index.unique === true && JSON.stringify(index.key) === JSON.stringify({ [field]: 1 })
      && JSON.stringify(index.partialFilterExpression) === JSON.stringify({ verified: true })));
  } catch (error) { if (error.code === 26) return false; throw error; }
}
export function paymentError(res, error) {
  const status = [400, 404, 409, 503].includes(error.status) ? error.status : 503;
  return res.status(status).json({ success: false, message: error.status ? error.message : "Payment verification is temporarily unavailable. Please try again." });
}

// Only this signed-webhook path can create verified payments and mark a booking paid.
export async function fulfillCheckout(stripeSessionId, eventCreated) {
  const stripe = getStripe();
  const checkout = await stripe.checkout.sessions.retrieve(stripeSessionId, { expand: ["payment_intent"] });
  if (checkout.metadata?.fixmate !== "booking") return false;
  const intent = checkout.payment_intent;
  if (checkout.livemode !== false || checkout.mode !== "payment" || checkout.status !== "complete"
    || checkout.payment_status !== "paid" || checkout.currency !== "usd"
    || !intent || typeof intent === "string" || intent.livemode !== false || intent.status !== "succeeded"
    || intent.currency !== "usd" || intent.amount_received !== checkout.amount_total
    || !ObjectId.isValid(checkout.metadata.bookingId)) {
    throw Object.assign(new Error("Checkout payment is not verified."), { status: 400 });
  }
  if (!await paymentIndexesReady()) throw Object.assign(new Error("Payment database setup is not ready."), { status: 503 });
  const { bookingsCollection, paymentsCollection } = getCollections();
  const bookingId = checkout.metadata.bookingId;
  return withDatabaseTransaction(async session => {
    const booking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId) }, { session });
    if (!booking || booking.status !== "completed" || booking.checkoutRequestId !== checkout.metadata.checkoutRequestId
      || checkout.client_reference_id !== bookingId || checkout.customer_email !== booking.customerEmail
      || booking.checkoutCurrency !== "usd" || booking.checkoutAmount !== checkout.amount_total
      || minorAmount(booking.finalAmount) !== checkout.amount_total
      || (booking.stripeSessionId && booking.stripeSessionId !== checkout.id)
      || intent.metadata?.bookingId !== bookingId || intent.metadata?.checkoutRequestId !== booking.checkoutRequestId) {
      throw Object.assign(new Error("Checkout does not match the booking."), { status: 400 });
    }
    const existing = await paymentsCollection.findOne({ bookingId, verified: true }, { session });
    if (existing) {
      if (verifiedPayment(existing) && existing.stripeSessionId === checkout.id && existing.transactionId === intent.id
        && booking.paymentStatus === "paid") return true;
      throw Object.assign(new Error("A different payment is already recorded."), { status: 409 });
    }
    if (booking.paymentStatus !== "unpaid") throw Object.assign(new Error("Booking payment state has changed."), { status: 409 });
    const paidAt = new Date(eventCreated * 1000);
    await paymentsCollection.insertOne({
      bookingId, serviceTitle: booking.serviceTitle, customerName: booking.customerName,
      customerEmail: booking.customerEmail, technicianName: booking.technicianName,
      technicianEmail: booking.technicianEmail, amount: checkout.amount_total / 100,
      currency: "usd", transactionId: intent.id, stripeSessionId: checkout.id,
      paymentStatus: "paid", paidAt, verified: true, verificationSource: "stripe-webhook", testMode: true,
    }, { session });
    const result = await bookingsCollection.updateOne({
      _id: booking._id, customerEmail: booking.customerEmail, status: "completed", paymentStatus: "unpaid",
      checkoutRequestId: booking.checkoutRequestId, finalAmount: booking.finalAmount,
    }, { $set: { paymentStatus: "paid", stripeSessionId: checkout.id, paidAt, updatedAt: new Date() } }, { session });
    if (result.modifiedCount !== 1) throw new Error("Booking changed during payment verification");
    return true;
  });
}

export async function stripeWebhook(req, res) {
  let event;
  try {
    const stripe = getStripe();
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ success: false, message: "Raw webhook body required" });
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(error.status === 503 ? 503 : 400).json({ success: false, message: error.status === 503 ? "Stripe Test Mode is not configured yet" : "Invalid webhook signature" });
  }
  if (event.livemode !== false) return res.status(400).json({ success: false, message: "Only Stripe Test Mode events are accepted" });
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)
    || event.data.object.metadata?.fixmate !== "booking") return res.json({ received: true, ignored: true });
  try {
    await fulfillCheckout(event.data.object.id, event.created);
    res.json({ received: true });
  } catch (error) {
    // A concurrent duplicate can retry safely; no event logs or secrets are exposed.
    paymentError(res, error);
  }
}
