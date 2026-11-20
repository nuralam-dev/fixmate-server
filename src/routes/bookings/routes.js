import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../../config/db.js";
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

export default router;
