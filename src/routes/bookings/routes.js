import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections, withDatabaseTransaction } from "../../config/db.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { requireRole } from "../../middleware/requireRole.js";

const router = Router();

router.get("/technician", verifyToken, requireRole("technician"), async (req, res, next) => {
  try {
    const { bookingsCollection } = getCollections();
    const bookings = await bookingsCollection
      .find({ technicianEmail: req.user.email })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    res.status(200).json({ success: true, message: "Your booking requests fetched successfully", data: bookings });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/status", verifyToken, requireRole("technician"), async (req, res, next) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid booking ID" });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !["accepted", "rejected"].includes(body.status)) {
    return res.status(400).json({ success: false, message: "Send only status: accepted or rejected" });
  }

  try {
    const { bookingsCollection } = getCollections();
    const owner = { _id: new ObjectId(req.params.id), technicianEmail: req.user.email };
    const booking = await bookingsCollection.findOneAndUpdate(
      { ...owner, status: "requested" },
      { $set: { status: body.status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!booking) {
      const existing = await bookingsCollection.findOne(owner, { projection: { _id: 1 } });
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing
          ? "This booking has already changed status. Refresh your requests."
          : "Booking not found",
      });
    }
    res.status(200).json({
      success: true,
      message: `Booking ${body.status} successfully`,
      data: booking,
    });
  } catch (error) {
    next(error);
  }
});


router.post("/", verifyToken, requireRole("customer"), async (req, res, next) => {
  const body = req.body;
  const fields = ["serviceId", "customerPhone", "address", "preferredDate", "problemDescription"];
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key))
    || fields.some(key => typeof body[key] !== "string" || !body[key].trim())) {
    return res.status(400).json({ success: false, message: "Send only serviceId, customerPhone, address, preferredDate and problemDescription" });
  }
  if (!ObjectId.isValid(body.serviceId)) {
    return res.status(400).json({ success: false, message: "Invalid service ID" });
  }
  const customerPhone = body.customerPhone.trim();
  const address = body.address.trim();
  const problemDescription = body.problemDescription.trim();
  const preferredDate = new Date(`${body.preferredDate}T00:00:00.000Z`);
  if (!/^[+0-9() .-]{6,30}$/.test(customerPhone) || customerPhone.replace(/\D/g, "").length < 6
    || address.length > 500 || problemDescription.length > 2000
    || !/^\d{4}-\d{2}-\d{2}$/.test(body.preferredDate)
    || !Number.isFinite(preferredDate.getTime()) || preferredDate.toISOString().slice(0, 10) !== body.preferredDate
    || body.preferredDate < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ success: false, message: "Enter a valid phone, address, problem description and a preferred date today or later" });
  }
  try {
    const { servicesCollection, bookingsCollection } = getCollections();
    // Deployment must explicitly install the approved unique partial index.
    // A frontend guard or find-before-insert cannot prevent concurrent duplicates.
    const indexes = await bookingsCollection.listIndexes().toArray();
    const ready = indexes.some(index => index.unique === true
      && JSON.stringify(index.key) === JSON.stringify({ customerEmail: 1, serviceId: 1 })
      && JSON.stringify(index.partialFilterExpression) === JSON.stringify({ status: { $in: ["requested", "accepted", "in-progress"] } }));
    if (!ready) return res.status(503).json({ success: false, message: "Booking setup is not ready yet. Please try again later." });

    const booking = await withDatabaseTransaction(async session => {
      const service = await servicesCollection.findOneAndUpdate(
        { _id: new ObjectId(body.serviceId), approvalStatus: "approved", isAvailable: true },
        // A real service write coordinates with transactional deletion and availability edits.
        { $inc: { bookingRevision: 1 } },
        { returnDocument: "after", session },
      );
      if (!service) return null;
      if (!Number.isFinite(service.basePrice) || service.basePrice <= 0
        || typeof service.technicianEmail !== "string" || !service.technicianEmail.trim()) {
        throw new Error("Invalid stored service");
      }
      const now = new Date();
      const record = {
        _id: new ObjectId(), serviceId: service._id.toHexString(),
        serviceTitle: service.title, serviceImage: service.image, category: service.category,
        basePrice: service.basePrice, technicianName: service.technicianName,
        technicianEmail: service.technicianEmail, customerName: req.user.name,
        customerEmail: req.user.email, customerPhone, address, preferredDate,
        problemDescription, status: "requested", finalAmount: null,
        paymentStatus: "unpaid", createdAt: now, updatedAt: now,
      };
      await bookingsCollection.insertOne(record, { session });
      return record;
    });
    if (!booking) return res.status(404).json({ success: false, message: "Service not found or unavailable" });
    res.status(201).json({ success: true, message: "Repair request created successfully", data: booking });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "You already have an active booking for this service" });
    }
    next(error);
  }
});

// Customer identity comes only from the verified BetterAuth session.
router.get("/my", verifyToken, requireRole("customer"), async (req, res, next) => {
  try {
    const { bookingsCollection } = getCollections();
    const bookings = await bookingsCollection
      .find({ customerEmail: req.user.email })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    res.status(200).json({ success: true, message: "Your bookings fetched successfully", data: bookings });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/cancel", verifyToken, requireRole("customer"), async (req, res, next) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid booking ID" });
  }
  // No submitted identity, status or payment fields are accepted.
  if (req.body !== undefined && (!req.body || typeof req.body !== "object"
    || Array.isArray(req.body) || Object.keys(req.body).length !== 0)) {
    return res.status(400).json({ success: false, message: "Cancellation does not accept booking fields" });
  }
  try {
    const { bookingsCollection } = getCollections();
    const owner = { _id: new ObjectId(req.params.id), customerEmail: req.user.email };
    const booking = await bookingsCollection.findOneAndUpdate(
      { ...owner, status: "requested" },
      { $set: { status: "cancelled", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!booking) {
      const existing = await bookingsCollection.findOne(owner, { projection: { _id: 1 } });
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing ? "This booking can no longer be cancelled. Refresh your bookings." : "Booking not found",
      });
    }
    res.status(200).json({ success: true, message: "Booking cancelled successfully", data: booking });
  } catch (error) {
    next(error);
  }
});

export default router;
