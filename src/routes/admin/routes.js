import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../../config/db.js";
import { verifyToken } from "../../middleware/verifyToken.js";
import { requireRole } from "../../middleware/requireRole.js";

const router = Router();

router.get("/services", verifyToken, requireRole("admin"), async (req, res, next) => {
  try {
    const { servicesCollection } = getCollections();
    const services = await servicesCollection.find({})
      .sort({ createdAt: -1, _id: -1 }).toArray();
    res.status(200).json({ success: true, message: "All services fetched successfully", data: services });
  } catch (error) {
    next(error);
  }
});

router.patch("/services/:id/approval", verifyToken, requireRole("admin"), async (req, res, next) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid service ID" });
  }
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)
    || Object.keys(data).length !== 1
    || !["approved", "rejected"].includes(data.approvalStatus)) {
    return res.status(400).json({ success: false, message: "Send only approvalStatus: approved or rejected" });
  }

  try {
    const { servicesCollection } = getCollections();
    const _id = new ObjectId(req.params.id);
    // A repeated or racing decision cannot review an already processed service.
    const service = await servicesCollection.findOneAndUpdate(
      { _id, approvalStatus: "pending" },
      { $set: { approvalStatus: data.approvalStatus, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!service) {
      const existing = await servicesCollection.findOne({ _id }, { projection: { _id: 1 } });
      return res.status(existing ? 409 : 404).json({
        success: false,
        message: existing ? "This service has already been reviewed. Refresh your services." : "Service not found",
      });
    }
    res.status(200).json({
      success: true,
      message: `Service ${data.approvalStatus} successfully`,
      data: service,
    });
  } catch (error) {
    next(error);
  }
});

const userProjection = {
  _id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  createdAt: 1,
};
const bookingProjection = Object.fromEntries(
  [
    "_id",
    "serviceId",
    "serviceTitle",
    "serviceImage",
    "category",
    "basePrice",
    "finalAmount",
    "customerName",
    "customerEmail",
    "customerPhone",
    "address",
    "preferredDate",
    "problemDescription",
    "technicianName",
    "technicianEmail",
    "status",
    "paymentStatus",
    "createdAt",
  ].map((field) => [field, 1]),
);
const paymentProjection = Object.fromEntries(
  [
    "_id",
    "bookingId",
    "serviceTitle",
    "customerName",
    "customerEmail",
    "technicianName",
    "technicianEmail",
    "amount",
    "currency",
    "transactionId",
    "stripeSessionId",
    "paymentStatus",
    "paidAt",
  ].map((field) => [field, 1]),
);
const newest = { createdAt: -1, _id: -1 };

// No Stripe/webhook producer exists. Stored status alone is not payment proof.
// Enable verified revenue only alongside an audited server-side payment integration.
function paymentSummary() {
  return {
    verificationAvailable: false,
    revenue: [],
    dependency:
      "Stripe payment verification is not implemented. Records are read-only; verified revenue is unavailable.",
  };
}

router.get(
  "/overview",
  verifyToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const {
        usersCollection: users,
        servicesCollection: services,
        bookingsCollection: bookings,
        paymentsCollection: payments,
      } = getCollections();
      // Prepare cursors before starting count promises so a synchronous query error
      // cannot leave already-started operations with unhandled rejections.
      const latestServiceQuery = services
        .find(
          {},
          {
            projection: {
              _id: 1,
              title: 1,
              category: 1,
              technicianName: 1,
              approvalStatus: 1,
              createdAt: 1,
            },
          },
        )
        .sort(newest)
        .limit(5);
      const latestBookingQuery = bookings
        .find({}, { projection: bookingProjection })
        .sort(newest)
        .limit(5);
      const [
        totalUsers,
        totalCustomers,
        totalTechnicians,
        totalServices,
        pendingServiceApprovals,
        totalBookings,
        activeBookings,
        completedBookings,
        paymentRecordCount,
        latestServices,
        latestBookings,
      ] = await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "customer" }),
        users.countDocuments({ role: "technician" }),
        services.countDocuments({}),
        services.countDocuments({ approvalStatus: "pending" }),
        bookings.countDocuments({}),
        bookings.countDocuments({
          status: { $in: ["accepted", "in-progress"] },
        }),
        bookings.countDocuments({ status: "completed" }),
        payments.countDocuments({}),
        latestServiceQuery.toArray(),
        latestBookingQuery.toArray(),
      ]);
      res.json({
        success: true,
        message: "Admin overview fetched successfully",
        data: {
          counts: {
            totalUsers,
            totalCustomers,
            totalTechnicians,
            totalServices,
            pendingServiceApprovals,
            totalBookings,
            activeBookings,
            completedBookings,
          },
          latestServices,
          latestBookings,
          paymentRecordCount,
          payments: paymentSummary(),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/users",
  verifyToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { usersCollection } = getCollections();
      const data = await usersCollection
        .find({}, { projection: userProjection })
        .sort(newest)
        .toArray();
      res.json({ success: true, message: "Users fetched successfully", data });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/users/:id/role",
  verifyToken,
  requireRole("admin"),
  async (req, res, next) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user ID" });
    }
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !["customer", "technician"].includes(body.role)
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Send only role: customer or technician",
        });
    }
    if (req.params.id.toLowerCase() === req.user.id.toLowerCase()) {
      return res
        .status(403)
        .json({ success: false, message: "You cannot change your own role" });
    }
    try {
      const { usersCollection } = getCollections();
      const _id = new ObjectId(req.params.id);
      // Existing admins cannot be demoted here; concurrent promotions cannot be overwritten.
      const user = await usersCollection.findOneAndUpdate(
        { _id, role: { $in: ["customer", "technician"] } },
        { $set: { role: body.role, updatedAt: new Date() } },
        { returnDocument: "after", projection: userProjection },
      );
      if (!user) {
        const existing = await usersCollection.findOne(
          { _id },
          { projection: { _id: 1 } },
        );
        return res
          .status(existing ? 403 : 404)
          .json({
            success: false,
            message: existing
              ? "Only customer and technician roles can be changed"
              : "User not found",
          });
      }
      res.json({
        success: true,
        message: "User role updated successfully",
        data: user,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/bookings",
  verifyToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { bookingsCollection } = getCollections();
      const data = await bookingsCollection
        .find({}, { projection: bookingProjection })
        .sort(newest)
        .toArray();
      res.json({
        success: true,
        message: "Bookings fetched successfully",
        data,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/payments",
  verifyToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { paymentsCollection } = getCollections();
      const records = await paymentsCollection
        .find({}, { projection: paymentProjection })
        .sort({ paidAt: -1, _id: -1 })
        .toArray();
      res.json({
        success: true,
        message: "Payment records fetched successfully",
        data: { records, ...paymentSummary() },
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
