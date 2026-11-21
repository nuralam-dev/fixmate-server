import Stripe from "stripe";
import { ObjectId } from "mongodb";
import { getCollections, withDatabaseTransaction } from "./db.js";

export const paymentProjection = Object.fromEntries([
  "_id", "bookingId", "serviceTitle", "customerName", "customerEmail", "technicianName",
  "technicianEmail", "amount", "currency", "transactionId", "stripeSessionId",
  "paymentStatus", "paidAt", "verified", "verificationSource", "testMode",
].map(field => [field, 1]));

export function verifiedPayment(record) {
  return record.verified === true && ["stripe-webhook", "stripe-api"].includes(record.verificationSource)
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

// Webhooks and authenticated reconciliation share the same trusted Stripe verification.
export async function fulfillCheckout(stripeSessionId, eventCreated = Math.floor(Date.now() / 1000), source = "stripe-webhook") {
  const stripe = getStripe();
  const checkout = await stripe.checkout.sessions.retrieve(stripeSessionId, { expand: ["payment_intent.latest_charge"] });
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
        && existing.customerEmail === booking.customerEmail && minorAmount(existing.amount) === checkout.amount_total) {
        if (booking.paymentStatus === "paid") return true;
        const repaired = await bookingsCollection.updateOne({ _id: booking._id, paymentStatus: "unpaid", checkoutRequestId: booking.checkoutRequestId },
          { $set: { paymentStatus: "paid", stripeSessionId: checkout.id, paidAt: existing.paidAt, updatedAt: new Date() } }, { session });
        if (repaired.modifiedCount !== 1) throw new Error("Booking changed during payment verification");
        return true;
      }
      throw Object.assign(new Error("A different payment is already recorded."), { status: 409 });
    }
    if (booking.paymentStatus !== "unpaid") throw Object.assign(new Error("Booking payment state has changed."), { status: 409 });
    const paidAt = new Date((source === "stripe-api" && intent.latest_charge?.created || eventCreated) * 1000);
    await paymentsCollection.insertOne({
      bookingId, serviceTitle: booking.serviceTitle, customerName: booking.customerName,
      customerEmail: booking.customerEmail, technicianName: booking.technicianName,
      technicianEmail: booking.technicianEmail, amount: checkout.amount_total / 100,
      currency: "usd", transactionId: intent.id, stripeSessionId: checkout.id,
      paymentStatus: "paid", paidAt, verified: true, verificationSource: source, testMode: true,
    }, { session });
    const result = await bookingsCollection.updateOne({
      _id: booking._id, customerEmail: booking.customerEmail, status: "completed", paymentStatus: "unpaid",
      checkoutRequestId: booking.checkoutRequestId, finalAmount: booking.finalAmount,
    }, { $set: { paymentStatus: "paid", stripeSessionId: checkout.id, paidAt, updatedAt: new Date() } }, { session });
    if (result.modifiedCount !== 1) throw new Error("Booking changed during payment verification");
    return true;
  });
}

// Never release an attempt or start another payment without checking Stripe first.
export async function checkoutState(booking) {
  const { paymentsCollection } = getCollections();
  const existing = await paymentsCollection.findOne({ bookingId: booking._id.toHexString(), verified: true });
  if (!booking.stripeSessionId) {
    if (existing) throw Object.assign(new Error("An existing payment needs verification. Please contact FixMate support."), { status: 409 });
    if (booking.checkoutRequestId && (!booking.checkoutStartedAt || Date.now() - new Date(booking.checkoutStartedAt).getTime() > 23 * 60 * 60 * 1000)) {
      throw Object.assign(new Error("The previous Checkout attempt needs confirmation. Please contact FixMate support before paying again."), { status: 409 });
    }
    return { state: booking.paymentStatus === "paid" ? "paid" : "retry" };
  }
  const checkout = await getStripe().checkout.sessions.retrieve(booking.stripeSessionId, { expand: ["payment_intent"] });
  const intent = checkout.payment_intent;
  const bookingId = booking._id.toHexString();
  if (checkout.livemode !== false || checkout.mode !== "payment" || checkout.currency !== "usd"
    || checkout.metadata?.fixmate !== "booking" || checkout.metadata?.bookingId !== bookingId
    || checkout.metadata?.checkoutRequestId !== booking.checkoutRequestId || checkout.client_reference_id !== bookingId
    || checkout.customer_email !== booking.customerEmail || checkout.amount_total !== minorAmount(booking.finalAmount)
    || booking.checkoutAmount !== checkout.amount_total || booking.checkoutCurrency !== "usd"
    || (intent && (typeof intent === "string" || intent.livemode !== false || intent.currency !== "usd"
      || intent.metadata?.bookingId !== bookingId || intent.metadata?.checkoutRequestId !== booking.checkoutRequestId))) {
    throw Object.assign(new Error("Stored Checkout does not match this booking. Please contact FixMate support."), { status: 409 });
  }
  if (checkout.payment_status === "paid" || intent?.status === "succeeded") {
    await fulfillCheckout(checkout.id, Math.floor(Date.now() / 1000), "stripe-api");
    return { state: "paid" };
  }
  if (existing || booking.paymentStatus === "paid") throw Object.assign(new Error("An existing payment needs verification. Please contact FixMate support."), { status: 409 });
  if (intent && !["requires_payment_method", "requires_confirmation", "canceled"].includes(intent.status)) return { state: "processing" };
  if (checkout.status === "expired") return { state: "retry", checkout };
  if (checkout.status === "open" && checkout.payment_status === "unpaid" && checkout.url) return { state: "open", checkout };
  // A failed asynchronous payment leaves a complete Session. Its failed intent cannot be reused.
  if (checkout.status === "complete" && checkout.payment_status === "unpaid"
    && intent && ["requires_payment_method", "canceled"].includes(intent.status)) return { state: "retry", checkout };
  return { state: "processing" };
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
    if (event.type === "checkout.session.completed" && event.data.object.payment_status === "unpaid") {
      return res.json({ received: true, processing: true });
    }
    await fulfillCheckout(event.data.object.id, event.created);
    res.json({ received: true });
  } catch (error) {
    console.error("Stripe fulfillment failed", { eventId: event.id, type: event.type, status: error.status || 503 });
    paymentError(res, error);
  }
}
