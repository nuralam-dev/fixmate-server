import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../../config/db.js";

import { verifyToken } from "../../middleware/verifyToken.js";
import { requireRole } from "../../middleware/requireRole.js";

const serviceRouter = Router();

serviceRouter.get("/", async (req, res, next) => {
  try {
    const { servicesCollection } = getCollections();
    const services = await servicesCollection
      .find({ approvalStatus: "approved", isAvailable: true })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json({ success: true, message: "Services fetched successfully", data: services });
  } catch (error) {
    next(error);
  }
});

// Keep the static ownership route before /:id.
serviceRouter.get("/my", verifyToken, requireRole("technician"), async (req, res, next) => {
  try {
    const { servicesCollection } = getCollections();
    const services = await servicesCollection
      .find({ technicianEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json({ success: true, message: "Your services fetched successfully", data: services });
  } catch (error) {
    next(error);
  }
});

serviceRouter.get("/:id", async (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid service ID" });
  }

  try {
    const { servicesCollection } = getCollections();
    const service = await servicesCollection.findOne({
      _id: new ObjectId(req.params.id),
      approvalStatus: "approved",
      isAvailable: true,
    });

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    res.status(200).json({ success: true, message: "Service fetched successfully", data: service });
  } catch (error) {
    next(error);
  }
});

// Shared create/edit validation keeps service fields consistent.
const editableFields = [
  "title", "category", "description", "image", "basePrice",
  "estimatedDuration", "serviceMode", "serviceArea",
];

function validateService(data, partial = false) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Service data must be a JSON object" };
  }
  if (partial && (!Object.keys(data).length || Object.keys(data).some(field => !editableFields.includes(field)))) {
    return { error: "Send only supported editable service fields" };
  }
  const requiredFields = [
    "title", "category", "description", "image", "estimatedDuration",
    "serviceMode", "serviceArea",
  ];
  for (const field of requiredFields) {
    if (partial && !Object.hasOwn(data, field)) continue;
    if (typeof data[field] !== "string" || !data[field].trim()) {
      return { error: `${field} is required and must be text` };
    }
  }

  if ((!partial || Object.hasOwn(data, "basePrice")) && (typeof data.basePrice !== "number" || !Number.isFinite(data.basePrice) || data.basePrice <= 0)) {
    return { error: "Base price must be a positive number" };
  }

  const categories = ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"];
  if (Object.hasOwn(data, "category") && !categories.includes(data.category.trim())) {
    return { error: "Select a valid service category" };
  }

  // Preserve the two unambiguous legacy form values using Assignment 9 names.
  let serviceMode = data.serviceMode?.trim();
  if (serviceMode === "At home") serviceMode = "Home Visit";
  if (serviceMode === "Workshop") serviceMode = "Shop Drop-off";
  if (Object.hasOwn(data, "serviceMode") && !["Home Visit", "Shop Drop-off"].includes(serviceMode)) {
    return { error: "Select a valid service mode" };
  }

  if (Object.hasOwn(data, "image") && !/^https?:\/\/\S+$/i.test(data.image.trim())) {
    return { error: "Service image must be an HTTP or HTTPS URL" };
  }

  const fields = {};
  for (const field of requiredFields) {
    if (Object.hasOwn(data, field)) fields[field] = data[field].trim();
  }
  if (Object.hasOwn(data, "basePrice")) fields.basePrice = data.basePrice;
  if (Object.hasOwn(data, "serviceMode")) fields.serviceMode = serviceMode;
  return { fields };
}

serviceRouter.post("/", verifyToken, requireRole("technician"), async (req, res, next) => {
  const { fields, error } = validateService(req.body);
  if (error) return res.status(400).json({ success: false, message: error });
  const newService = {
    ...fields,
    technicianName: req.user.name,
    technicianEmail: req.user.email,
    approvalStatus: "pending",
    isAvailable: true,
    createdAt: new Date(),
  };

  try {
    const { servicesCollection } = getCollections();
    const result = await servicesCollection.insertOne(newService);
    res.status(201).json({
      success: true,
      message: "Service added successfully",
      data: { ...newService, _id: result.insertedId },
    });
  } catch (error) {
    next(error);
  }
});

// Both the lookup and atomic update include the verified owner.
serviceRouter.patch("/:id", verifyToken, requireRole("technician"), async (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid service ID" });
  }
  const { fields, error } = validateService(req.body, true);
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const { servicesCollection } = getCollections();
    const owner = { _id: new ObjectId(req.params.id), technicianEmail: req.user.email };
    // Compare inside MongoDB, so an unchanged submission cannot reset approval,
    // even if another request edits or approves the service at the same time.
    const updated = await servicesCollection.findOneAndUpdate(
      { ...owner, $or: Object.entries(fields).map(([field, value]) => ({ [field]: { $ne: value } })) },
      { $set: { ...fields, approvalStatus: "pending", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    const service = updated || await servicesCollection.findOne(owner);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.status(200).json({
      success: true,
      message: updated ? "Service updated and submitted for approval" : "No service changes to save",
      data: service,
    });
  } catch (error) {
    next(error);
  }
});

serviceRouter.patch("/:id/availability", verifyToken, requireRole("technician"), async (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid service ID" });
  }
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)
    || typeof data.isAvailable !== "boolean" || Object.keys(data).some(field => field !== "isAvailable")) {
    return res.status(400).json({ success: false, message: "Send only isAvailable as a Boolean" });
  }
  try {
    const { servicesCollection } = getCollections();
    const service = await servicesCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), technicianEmail: req.user.email },
      { $set: { isAvailable: data.isAvailable, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.status(200).json({ success: true, message: "Service availability updated", data: service });
  } catch (error) {
    next(error);
  }
});

serviceRouter.delete("/:id", verifyToken, requireRole("technician"), async (req, res, next) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid service ID" });
  }
  try {
    const { servicesCollection, bookingsCollection, paymentsCollection } = getCollections();
    const serviceId = new ObjectId(req.params.id);
    const owner = { _id: serviceId, technicianEmail: req.user.email };
    const service = await servicesCollection.findOne(owner);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    // No persisted booking schema exists yet. Support both common reference types.
    const reference = { serviceId: { $in: [serviceId, serviceId.toHexString(), req.params.id] } };
    const activeBooking = await bookingsCollection.findOne({
      ...reference,
      status: { $in: ["requested", "accepted", "in-progress"] },
    }, { projection: { _id: 1 } });
    if (activeBooking) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete this service because it has active bookings.",
      });
    }

    // Keep references intact until a booking history/snapshot contract is implemented.
    // Payments linked through bookingId are protected by retaining every booking.
    const historicalBooking = await bookingsCollection.findOne(reference, { projection: { _id: 1 } });
    const directPayment = await paymentsCollection.findOne(reference, { projection: { _id: 1 } });
    if (historicalBooking || directPayment) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete this service because it has booking or payment history. You can make it unavailable instead.",
      });
    }

    const result = await servicesCollection.deleteOne(owner);
    if (result.deletedCount !== 1) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.status(200).json({ success: true, message: "Service deleted successfully" });
  } catch (error) {
    next(error);
  }
});

export default serviceRouter;
