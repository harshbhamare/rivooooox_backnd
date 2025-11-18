import express from "express";
import { supabase } from '../db/supabaseClient.js'
import { authenticateUser, authorizeRoles  } from "../middlewares/auth.js";

const router = express.Router();

// Get director profile
router.get("/profile", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, email, role")
      .eq("id", userId)
      .single();

    if (error) throw error;

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/departments", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    // Get all departments
    const { data: departments, error: deptError } = await supabase
      .from("departments")
      .select("id, name, created_at")
      .order("id", { ascending: true });

    if (deptError) throw deptError;

    // Get all HODs (users with role 'hod' and their department_id)
    const { data: hods, error: hodError } = await supabase
      .from("users")
      .select("id, name, department_id, role")
      .eq("role", "hod");

    if (hodError) throw hodError;

    // Map departments with their assigned HOD
    const formatted = departments.map((dept) => {
      const assignedHod = hods.find(hod => hod.department_id === dept.id);
      return {
        id: dept.id,
        name: dept.name,
        hod: assignedHod ? assignedHod.name : null,
        hod_id: assignedHod ? assignedHod.id : null,
      };
    });

    res.json({ success: true, departments: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/hods", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, name, email, role")
      .in("role", ["hod", "faculty"]); // Fetch HODs or faculty

    if (error) throw error;

    res.json({ success: true, hods: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/departments", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: "Department name is required" });
    }

    const { data, error } = await supabase
      .from("departments")
      .insert([{ name }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ success: true, department: data });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: err.message || "Something went wrong" });
  }
});


router.post("/assign-hod", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    const { user_id, department_id } = req.body;

    if (!user_id || !department_id) {
      return res
        .status(400)
        .json({ success: false, error: "user_id and department_id are required" });
    }

    // Check if department exists
    const { data: dept, error: deptError } = await supabase
      .from("departments")
      .select("id, name")
      .eq("id", department_id)
      .single();

    if (deptError || !dept) {
      return res.status(404).json({ success: false, error: "Department not found" });
    }

    // Check if user exists
    const { data: user, error: userCheckError } = await supabase
      .from("users")
      .select("id, name, role")
      .eq("id", user_id)
      .single();

    if (userCheckError || !user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Remove department_id from any other user who was HOD of this department
    await supabase
      .from("users")
      .update({ department_id: null })
      .eq("department_id", department_id)
      .eq("role", "hod");

    // Update the selected user's role to 'hod' and assign department_id
    const { data, error } = await supabase
      .from("users")
      .update({ role: "hod", department_id })
      .eq("id", user_id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: "HOD assigned successfully",
      data: data,
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: err.message || "Something went wrong" });
  }
});

router.delete("/departments/:id", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    const { id } = req.params;

    // First, remove department_id from all users in this department
    await supabase
      .from("users")
      .update({ department_id: null })
      .eq("department_id", id);

    // Then delete the department
    const { error } = await supabase
      .from("departments")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true, message: "Department deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete faculty/HOD
router.delete("/faculty/:id", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const { data: existingUser, error: checkError } = await supabase
      .from("users")
      .select("id, role")
      .eq("id", id)
      .single();

    if (checkError || !existingUser) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Delete the user
    const { error } = await supabase
      .from("users")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true, message: "Faculty deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get department-wise submission statistics
router.get("/department-statistics", authenticateUser, authorizeRoles("director"), async (req, res) => {
  try {
    console.log('📊 Fetching department statistics for director');

    // Get all departments
    const { data: departments, error: deptError } = await supabase
      .from("departments")
      .select("id, name")
      .order("name", { ascending: true });

    if (deptError) throw deptError;

    // Calculate statistics for each department
    const deptStats = await Promise.all(
      (departments || []).map(async (dept) => {
        // Get all classes in this department
        const { data: classes, error: classesError } = await supabase
          .from("classes")
          .select("id")
          .eq("department_id", dept.id);

        if (classesError) throw classesError;

        const classIds = (classes || []).map(c => c.id);

        if (classIds.length === 0) {
          return {
            id: dept.id,
            name: dept.name,
            submissionRate: 0,
            totalStudents: 0,
            completedStudents: 0,
            classCount: 0
          };
        }

        // Get all students in these classes
        const { data: students, error: studentsError } = await supabase
          .from("students")
          .select("id")
          .in("class_id", classIds);

        if (studentsError) throw studentsError;

        const totalStudents = students?.length || 0;

        if (totalStudents === 0) {
          return {
            id: dept.id,
            name: dept.name,
            submissionRate: 0,
            totalStudents: 0,
            completedStudents: 0,
            classCount: classIds.length
          };
        }

        const studentIds = students.map(s => s.id);

        // Get all submissions for these students
        const { data: submissions, error: submissionsError } = await supabase
          .from("student_submissions")
          .select("student_id, submission_type_id, status")
          .in("student_id", studentIds);

        if (submissionsError) throw submissionsError;

        // Get submission types
        const { data: submissionTypes, error: typesError } = await supabase
          .from("submission_types")
          .select("*");

        if (typesError) throw typesError;

        const taType = submissionTypes.find(t => t.name === 'TA');
        const cieType = submissionTypes.find(t => t.name === 'CIE');

        // Calculate overall submission percentage
        const studentsWithSubmissions = new Set();
        submissions.forEach(sub => {
          if (sub.status === 'completed' && 
              (sub.submission_type_id === taType?.id || sub.submission_type_id === cieType?.id)) {
            studentsWithSubmissions.add(sub.student_id);
          }
        });

        const submissionRate = Math.round((studentsWithSubmissions.size / totalStudents) * 100);

        return {
          id: dept.id,
          name: dept.name,
          submissionRate,
          totalStudents,
          completedStudents: studentsWithSubmissions.size,
          classCount: classIds.length
        };
      })
    );

    console.log('✅ Department statistics calculated:', deptStats);

    return res.json({
      success: true,
      statistics: deptStats
    });
  } catch (err) {
    console.error("Error fetching department statistics:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
