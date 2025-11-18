
export default function dbCheck(req, res, next) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: "Supabase environment variables missing"
    });
  }
  next();
}
