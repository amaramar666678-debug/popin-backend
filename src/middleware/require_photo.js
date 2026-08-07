const { prisma } = require("./prisma");

async function requireProfilePhoto(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        images: { select: { id: true }, take: 1 },
      },
    });

    if (!user || user.images.length === 0) {
      return res.status(400).json({
        error: "profile_photo_required",
        message: "You must upload a profile photo before interacting.",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireProfilePhoto };
