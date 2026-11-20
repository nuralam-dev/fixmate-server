import { Router } from "express";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getCollections } from "../../config/db.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getStripe, minorAmount, paymentError, paymentIndexesReady, paymentProjection, paymentReport, verifiedPayment } from "../../config/payments.js";

const router = Router();
router.get("/status", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try { getStripe(); res.json({ success: true, data: { available: await paymentIndexesReady() } }); }
  catch { res.json({ success: true, data: { available: false } }); }
});
router.use(verifyToken, requireRole("customer"));
router.get("/my", async (req, res, next) => {
  try {
    const { paymentsCollection } = getCollections();
    const records = await paymentsCollection.find({ customerEmail: req.user.email }, { projection: paymentProjection }).sort({ paidAt: -1, _id: -1 }).toArray();
    res.json({ success: true, data: paymentReport(records) });
  } catch (error) { next(error); }
});
router.get("/session/:id", async (req, res, next) => {
  if (!/^cs_test_[A-Za-z0-9]+$/.test(req.params.id) || req.params.id.length > 250) return res.status(400).json({ success: false, message: "Invalid Checkout Session ID" });
  try {
    const { bookingsCollection, paymentsCollection } = getCollections();
    const booking = await bookingsCollection.findOne({ stripeSessionId: req.params.id, customerEmail: req.user.email });
    if (!booking) return res.status(404).json({ success: false, message: "Payment session not found" });
    const payment = await paymentsCollection.findOne({ bookingId: booking._id.toHexString(), stripeSessionId: req.params.id, customerEmail: req.user.email, verified: true }, { projection: paymentProjection });
    res.json({ success: true, data: { paid: booking.paymentStatus === "paid" && !!payment && verifiedPayment(payment), payment: payment && verifiedPayment(payment) ? payment : null } });
  } catch (error) { next(error); }
});
router.post("/create-checkout-session", async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !ObjectId.isValid(req.body.bookingId)) {
    return res.status(400).json({ success: false, message: "Send only a valid bookingId" });
  }
  try {
    const stripe = getStripe();
    if (!await paymentIndexesReady()) throw Object.assign(new Error("Payment database setup is not ready."), { status: 503 });
    const { bookingsCollection } = getCollections();
    const owner = { _id: new ObjectId(req.body.bookingId), customerEmail: req.user.email };
    let booking = await bookingsCollection.findOne(owner);
    if (!booking) throw Object.assign(new Error("Booking not found"), { status: 404 });
    if (booking.status !== "completed" || booking.paymentStatus !== "unpaid") throw Object.assign(new Error("Only completed, unpaid bookings can be paid."), { status: 409 });
    const amount = minorAmount(booking.finalAmount);
    const clientUrl = new URL(process.env.CLIENT_URL || "http://localhost:3000");
    if (!["http:", "https:"].includes(clientUrl.protocol) || clientUrl.pathname !== "/" || (process.env.NODE_ENV === "production" && clientUrl.protocol !== "https:")) throw new Error("Invalid frontend origin");
    let previous;
    if (booking.stripeSessionId) {
      previous = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
      if (previous.livemode !== false || previous.metadata?.checkoutRequestId !== booking.checkoutRequestId) throw new Error("Invalid stored session");
      if (previous.status !== "expired") {
        if (previous.status === "open" && previous.amount_total === amount && previous.url && booking.checkoutAmount === amount) {
          return res.json({ success: true, data: { url: previous.url } });
        }
        throw Object.assign(new Error("A Checkout payment is already processing. Refresh My Bookings after verification."), { status: 409 });
      }
    }
    const eligible = { ...owner, status: "completed", paymentStatus: "unpaid", finalAmount: booking.finalAmount };
    if (!booking.checkoutRequestId || previous?.status === "expired") {
      const updated = await bookingsCollection.findOneAndUpdate({
        ...eligible, ...(booking.checkoutRequestId ? { checkoutRequestId: booking.checkoutRequestId, stripeSessionId: booking.stripeSessionId } : { checkoutRequestId: { $exists: false } }),
      }, { $set: { checkoutRequestId: randomUUID(), checkoutAmount: amount, checkoutCurrency: "usd" }, $unset: { stripeSessionId: "" } }, { returnDocument: "after" });
      booking = updated || await bookingsCollection.findOne(eligible);
    }
    if (!booking || !booking.checkoutRequestId || booking.checkoutAmount !== amount || booking.checkoutCurrency !== "usd") throw Object.assign(new Error("The booking changed. Refresh before paying."), { status: 409 });
    const metadata = { fixmate: "booking", bookingId: booking._id.toHexString(), checkoutRequestId: booking.checkoutRequestId };
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card"], customer_email: req.user.email,
      client_reference_id: metadata.bookingId, metadata, payment_intent_data: { metadata },
      line_items: [{ price_data: { currency: "usd", unit_amount: amount, product_data: { name: booking.serviceTitle || "FixMate repair" } }, quantity: 1 }],
      success_url: `${clientUrl.origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl.origin}/payment/cancel`,
    }, { idempotencyKey: `fixmate-${booking.checkoutRequestId}` });
    if (checkout.livemode !== false || !checkout.id.startsWith("cs_test_") || !checkout.url || new URL(checkout.url).origin !== "https://checkout.stripe.com") throw new Error("Invalid test Checkout response");
    const saved = await bookingsCollection.updateOne({ ...eligible, checkoutRequestId: booking.checkoutRequestId }, { $set: { stripeSessionId: checkout.id, updatedAt: new Date() } });
    if (saved.matchedCount !== 1) throw Object.assign(new Error("Booking payment state changed. Refresh My Bookings."), { status: 409 });
    res.json({ success: true, data: { url: checkout.url } });
  } catch (error) { paymentError(res, error); }
});
export default router;
