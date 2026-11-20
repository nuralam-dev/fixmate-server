import { Router } from "express";
import { getCollections } from "../../config/db.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { requireRole } from "../../middleware/requireRole.js";

const router = Router();

router.get("/overview", verifyToken, requireRole("technician"), async (req, res, next) => {
  try {
    const { servicesCollection, bookingsCollection } = getCollections();
    const owner = { technicianEmail: req.user.email };
    const recentQuery = bookingsCollection.find(owner, { projection: {
      _id: 1, serviceTitle: 1, customerName: 1, preferredDate: 1,
      status: 1, basePrice: 1, createdAt: 1,
    } }).sort({ createdAt: -1, _id: -1 }).limit(5);
    const [totalServices, pendingRequests, activeJobs, completedJobs, recentRequests] = await Promise.all([
      servicesCollection.countDocuments(owner),
      bookingsCollection.countDocuments({ ...owner, status: "requested" }),
      bookingsCollection.countDocuments({ ...owner, status: { $in: ["accepted", "in-progress"] } }),
      bookingsCollection.countDocuments({ ...owner, status: "completed" }),
      recentQuery.toArray(),
    ]);
    res.status(200).json({
      success: true,
      message: "Your technician overview fetched successfully",
      data: { totalServices, pendingRequests, activeJobs, completedJobs, recentRequests },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
