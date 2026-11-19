export function notFound(req, res) {
  res.status(404).json({ success: false, message: "Route not found" });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "Request body is too large" });
  }

  if (error.status === 415) {
    return res.status(415).json({ success: false, message: "Unsupported request encoding" });
  }

  console.error("An unexpected request error occurred.");
  res.status(500).json({ success: false, message: "Something went wrong" });
}
