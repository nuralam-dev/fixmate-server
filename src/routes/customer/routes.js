import { Router } from "express";
import { getCollections } from "../../config/db.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { requireRole } from "../../middleware/requireRole.js";

const router = Router();

router.get("/overview", verifyToken, requireRole("customer"), async (req, res, next) => {
  try {
    const { bookingsCollection } = getCollections();
    const owner = { customerEmail: req.user.email };
    const recentQuery = bookingsCollection.find(owner, { projection: {
      _id: 1, serviceTitle: 1, preferredDate: 1, status: 1, createdAt: 1,
    } }).sort({ createdAt: -1, _id: -1 }).limit(5);
    const [totalBookings, pendingRequests, activeBookings, completedBookings, recentBookings] = await Promise.all([
      bookingsCollection.countDocuments(owner),
      bookingsCollection.countDocuments({ ...owner, status: "requested" }),
      bookingsCollection.countDocuments({ ...owner, status: { $in: ["accepted", "in-progress"] } }),
      bookingsCollection.countDocuments({ ...owner, status: "completed" }),
      recentQuery.toArray(),
    ]);
    res.status(200).json({
      success: true,
      message: "Your customer overview fetched successfully",
      data: { totalBookings, pendingRequests, activeBookings, completedBookings, recentBookings },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
