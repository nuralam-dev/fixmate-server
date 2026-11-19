import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../../config/db.js";

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

// Private service reads stay disabled until verified technician identity exists.
// Keep this static route before /:id; query emails and bearer strings prove nothing.
serviceRouter.get("/my", (req, res) => {
  res.status(503).json({
    success: false,
    message: "My Services is unavailable until technician authentication is configured.",
  });
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

// Authentication and role checks are deferred for this integration phase.
serviceRouter.post("/", async (req, res, next) => {
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ success: false, message: "Service data must be a JSON object" });
  }

  const requiredFields = [
    "title", "category", "description", "image", "estimatedDuration",
    "serviceMode", "serviceArea", "technicianName", "technicianEmail",
  ];
  for (const field of requiredFields) {
    if (typeof data[field] !== "string" || !data[field].trim()) {
      return res.status(400).json({ success: false, message: `${field} is required and must be text` });
    }
  }

  if (typeof data.basePrice !== "number" || !Number.isFinite(data.basePrice) || data.basePrice <= 0) {
    return res.status(400).json({ success: false, message: "Base price must be a positive number" });
  }

  const categories = ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"];
  if (!categories.includes(data.category.trim())) {
    return res.status(400).json({ success: false, message: "Select a valid service category" });
  }

  // Preserve the two unambiguous legacy form values using Assignment 9 names.
  let serviceMode = data.serviceMode.trim();
  if (serviceMode === "At home") serviceMode = "Home Visit";
  if (serviceMode === "Workshop") serviceMode = "Shop Drop-off";
  if (!["Home Visit", "Shop Drop-off"].includes(serviceMode)) {
    return res.status(400).json({ success: false, message: "Select a valid service mode" });
  }

  if (!/^https?:\/\/\S+$/i.test(data.image.trim())) {
    return res.status(400).json({ success: false, message: "Service image must be an HTTP or HTTPS URL" });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.technicianEmail.trim())) {
    return res.status(400).json({ success: false, message: "Technician email must be valid" });
  }

  const newService = {};
  for (const field of requiredFields) newService[field] = data[field].trim();
  Object.assign(newService, {
    serviceMode,
    basePrice: data.basePrice,
    approvalStatus: "pending",
    isAvailable: true,
    createdAt: new Date(),
  });

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

export default serviceRouter;
