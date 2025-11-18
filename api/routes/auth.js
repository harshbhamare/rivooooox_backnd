// routes/auth.js
import express from "express";
// import bcrypt from "bcrypt";
import bcrypt from "bcryptjs";

import jwt from "jsonwebtoken";

import { supabase } from '../db/supabaseClient.js'
import { authenticateUser, authorizeRoles } from "../middlewares/auth.js";


const router = express.Router();

// Test route
router.get("/test", (req, res) => {
  res.json({ success: true, message: "Auth routes working!" });
});

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role, department_id } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ success: false, error: "All fields are required." });
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (existingUser) {
      return res.status(400).json({ success: false, error: "User already exists." });
    }

    // Hash password before saving
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert new user
    const { data, error } = await supabase
      .from("users")
      .insert([{ name, email, password: hashedPassword, role, department_id }])
      .select();

    if (error) throw error;

    res.status(201).json({ success: true, message: "User registered successfully", data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required.",
      });
    }

    // Fetch user by email
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .single();

    if (userError || !user) {
      return res.status(400).json({
        success: false,
        error: "Invalid credentials.",
      });
    }

    // Validate password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        error: "Invalid credentials.",
      });
    }

    // Base JWT payload
    let payload = {
      id: user.id,
      role: user.role,
    };

    // Add class_id if user is class_teacher
    if (user.role === "class_teacher") {
      const { data: classData, error: classError } = await supabase
        .from("classes")
        .select("id")
        .eq("class_teacher_id", user.id)
        .limit(1);

      if (classError) {
        console.error("Error fetching class for class_teacher:", classError);
      }

      if (classData && classData.length > 0) {
        payload.class_id = classData[0].id; // UUID
      } else {
        console.warn(`No class found for class_teacher_id = ${user.id}`);
      }
    }

    // Add department_id if user is HOD
    if (user.role === "hod") {
      const { data: hodData, error: hodError } = await supabase
        .from("users")
        .select("department_id")
        .eq("id", user.id)
        .single();

      if (hodError) {
        console.error("Error fetching department for HOD:", hodError);
        throw new Error("Unable to fetch department for HOD");
      }

      if (hodData?.department_id) {
        payload.department_id = hodData.department_id;
      } else {
        throw new Error(`No department_id found for HOD with user ID: ${user.id}`);
      }
    }


    // Generate JWT token
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    console.log("Token Payload:", payload);

    // Response
    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        email: user.email,
        class_id: payload.class_id || null,
        department_id: payload.department_id || null,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

router.post("/student/login", async (req, res) => {
  try {
    const { hall_ticket_number, password } = req.body;

    // 🧩 Basic validation
    if (!hall_ticket_number || !password) {
      return res.status(400).json({
        success: false,
        error: "Hall ticket number and password are required.",
      });
    }

    // 🧠 Fetch student by hall_ticket_number
    console.log('Looking for student with hall ticket:', hall_ticket_number);
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("*")
      .eq("hall_ticket_number", hall_ticket_number)
      .maybeSingle();

    console.log('Student login query result:', { student: student ? { id: student.id, name: student.name } : null, studentError });

    if (studentError || !student) {
      console.error("No student found:", studentError);
      return res.status(400).json({
        success: false,
        error: "Invalid hall ticket number or password.",
      });
    }

    // 🔐 Verify password (hashed hall_ticket_number)
    const isMatch = await bcrypt.compare(password, student.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        error: "Invalid hall ticket number or password.",
      });
    }

    // 🪪 Prepare JWT payload
    const payload = {
      id: student.id,
      role: "student",
      class_id: student.class_id,
      batch_id: student.batch_id,
    };

    console.log('Creating JWT with payload:', payload);

    // 🎟️ Generate JWT token
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

    // 📦 Respond
    return res.status(200).json({
      success: true,
      message: "Student login successful.",
      token,
      student: {
        id: student.id,
        name: student.name,
        roll_no: student.roll_no,
        hall_ticket_number: student.hall_ticket_number,
        email: student.email,
        mobile: student.mobile,
        class_id: student.class_id,
        batch_id: student.batch_id,
        defaulter: student.defaulter,
        role: "student", // Add role field for AuthWrapper routing
      },
    });
  } catch (err) {
    console.error("Student login error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
});


export default router;  