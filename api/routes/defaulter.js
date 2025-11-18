import express from "express";
import multer from "multer";
import xlsx from "xlsx";
import bcrypt from "bcryptjs";
import fs from "fs"
import { supabase } from '../db/supabaseClient.js'
import { authenticateUser, authorizeRoles  } from "../middlewares/auth.js";


const upload = multer({ dest: "uploads/" });

const calculateDefaulter = (attendance) => attendance < 75;

const router = express.Router();

router.post("/assign-defaulter-work", authenticateUser, authorizeRoles("faculty", "hod", "class_teacher"),
  async (req, res) => {
    try {
      const { subject_id, instruction_text, reference_link, skip } = req.body;
      const faculty_id = req.user.id;

      if (!subject_id) {
        return res
          .status(400)
          .json({ success: false, error: "subject_id is required." });
      }

      // Step 1: Get students for this subject
      // Check multiple sources: faculty_subjects, department_offered_subjects, and student_subject_selection
      let studentIds = [];
      
      // First, check if this is an elective subject by checking student_subject_selection
      const { data: electiveCheck, error: electiveCheckError } = await supabase
        .from('student_subject_selection')
        .select('student_id, mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id')
        .or(`mdm_id.eq.${subject_id},oe_id.eq.${subject_id},pe_id.eq.${subject_id}`)
        .limit(1);

      const isElectiveSubject = !electiveCheckError && electiveCheck && electiveCheck.length > 0;

      if (req.user.role === "class_teacher" && req.user.class_id) {
        if (isElectiveSubject) {
          // For elective subjects, only get students who selected this faculty for this subject
          const { data: electiveSelections, error: electiveError } = await supabase
            .from('student_subject_selection')
            .select('student_id, mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id')
            .or(`mdm_faculty_id.eq.${faculty_id},oe_faculty_id.eq.${faculty_id},pe_faculty_id.eq.${faculty_id}`);

          if (!electiveError && electiveSelections) {
            const electiveStudentIds = [];
            electiveSelections.forEach(selection => {
              if ((selection.mdm_faculty_id === faculty_id && selection.mdm_id === subject_id) ||
                  (selection.oe_faculty_id === faculty_id && selection.oe_id === subject_id) ||
                  (selection.pe_faculty_id === faculty_id && selection.pe_id === subject_id)) {
                electiveStudentIds.push(selection.student_id);
              }
            });

            if (electiveStudentIds.length > 0) {
              const { data: electiveStudents, error: electiveStudentsError } = await supabase
                .from('students')
                .select('id')
                .in('id', electiveStudentIds)
                .eq('class_id', req.user.class_id)
                .eq('defaulter', true);

              if (!electiveStudentsError && electiveStudents) {
                studentIds = electiveStudents.map(s => s.id);
              }
            }
          }
        } else {
          // For regular subjects, get all defaulter students from their class
          const { data: classStudents, error: classStudentsError } = await supabase
            .from("students")
            .select("id")
            .eq("class_id", req.user.class_id)
            .eq("defaulter", true);

          if (classStudentsError) throw classStudentsError;
          studentIds = (classStudents || []).map(s => s.id);
        }
      } else {
        // For faculty, check faculty_subjects first
        const { data: facultySubjectData, error: facultySubjectError } = await supabase
          .from("faculty_subjects")
          .select("class_id, batch_id")
          .eq("faculty_id", faculty_id)
          .eq("subject_id", subject_id);

        if (!facultySubjectError && facultySubjectData && facultySubjectData.length > 0) {
          // Get students from faculty_subjects assignments
          for (const assignment of facultySubjectData) {
            let query = supabase
              .from("students")
              .select("id")
              .eq("class_id", assignment.class_id)
              .eq("defaulter", true);

            if (assignment.batch_id) {
              query = query.eq("batch_id", assignment.batch_id);
            }

            const { data: students, error: studentsError } = await query;
            if (!studentsError && students) {
              studentIds.push(...students.map(s => s.id));
            }
          }
        }

        // Check student_subject_selection for elective subjects
        // This is the authoritative source for which students selected which faculty
        const { data: electiveSelections, error: electiveError } = await supabase
          .from('student_subject_selection')
          .select('student_id, mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id')
          .or(`mdm_faculty_id.eq.${faculty_id},oe_faculty_id.eq.${faculty_id},pe_faculty_id.eq.${faculty_id}`);

        if (!electiveError && electiveSelections) {
          const electiveStudentIds = [];
          electiveSelections.forEach(selection => {
            if ((selection.mdm_faculty_id === faculty_id && selection.mdm_id === subject_id) ||
                (selection.oe_faculty_id === faculty_id && selection.oe_id === subject_id) ||
                (selection.pe_faculty_id === faculty_id && selection.pe_id === subject_id)) {
              electiveStudentIds.push(selection.student_id);
            }
          });

          if (electiveStudentIds.length > 0) {
            const { data: electiveStudents, error: electiveStudentsError } = await supabase
              .from('students')
              .select('id')
              .in('id', electiveStudentIds)
              .eq('defaulter', true);

            if (!electiveStudentsError && electiveStudents) {
              studentIds.push(...electiveStudents.map(s => s.id));
            }
          }
        }
      }

      // Remove duplicates
      studentIds = [...new Set(studentIds)];

      console.log('📝 Assigning defaulter work:');
      console.log('   Subject ID:', subject_id);
      console.log('   Faculty ID:', faculty_id);
      console.log('   Student IDs found:', studentIds.length);
      console.log('   Students:', studentIds);

      // Step 2: Check if we found any defaulter students
      if (!studentIds || studentIds.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No defaulter students found for this subject.",
        });
      }

      // Step 3: Insert instruction for all defaulter students
      // Note: status field has a check constraint that only allows "pending" or "completed"
      // We use the skip boolean field to indicate if work is skipped, not the status field
      const insertPayload = studentIds.map((student_id) => ({
        student_id,
        subject_id,
        faculty_id,
        submission_text: skip
          ? "Skipped by faculty"
          : instruction_text || "No instructions provided.",
        reference_link: reference_link || null,
        created_at: new Date().toISOString(),
        skip: !!skip,
        status: "pending", // Status must be "pending" or "completed" per constraint
      }));

      console.log('📝 Insert payload count:', insertPayload.length);
      console.log('📝 Sample payload:', insertPayload[0]);

      const { error: insertError } = await supabase
        .from("defaulter_submissions")
        .insert(insertPayload);

      if (insertError) {
        console.error("❌ Insert error details:", insertError);
        throw insertError;
      }

      console.log('✅ Defaulter work assigned successfully to', insertPayload.length, 'students');

      return res.status(201).json({
        success: true,
        message: skip
          ? "Marked as skipped for all defaulter students."
          : "Defaulter work assigned successfully.",
        total_assigned: insertPayload.length,
      });
    } catch (err) {
      console.error("Error assigning defaulter work:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Get defaulter submissions for faculty
router.get("/submissions", authenticateUser, authorizeRoles("faculty", "hod", "class_teacher"),
  async (req, res) => {
    try {
      const faculty_id = req.user.id;

      // Get unique defaulter work assignments (grouped by subject)
      const { data: submissions, error } = await supabase
        .from("defaulter_submissions")
        .select(`
          id,
          subject_id,
          submission_text,
          reference_link,
          skip,
          created_at,
          subjects (
            id,
            name,
            subject_code,
            type
          )
        `)
        .eq("faculty_id", faculty_id)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Group by subject and get the latest submission for each
      const groupedSubmissions = {};
      submissions?.forEach(sub => {
        const subjectId = sub.subject_id;
        if (!groupedSubmissions[subjectId] || 
            new Date(sub.created_at) > new Date(groupedSubmissions[subjectId].created_at)) {
          groupedSubmissions[subjectId] = sub;
        }
      });

      const uniqueSubmissions = Object.values(groupedSubmissions);

      return res.json({
        success: true,
        submissions: uniqueSubmissions,
      });
    } catch (err) {
      console.error("Error fetching defaulter submissions:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Delete defaulter work for a subject
router.delete("/submissions/:subject_id", authenticateUser, authorizeRoles("faculty", "hod", "class_teacher"),
  async (req, res) => {
    try {
      const { subject_id } = req.params;
      const faculty_id = req.user.id;

      if (!subject_id) {
        return res.status(400).json({ success: false, error: "subject_id is required." });
      }

      // Delete all defaulter submissions for this subject by this faculty
      const { error: deleteError } = await supabase
        .from("defaulter_submissions")
        .delete()
        .eq("subject_id", subject_id)
        .eq("faculty_id", faculty_id);

      if (deleteError) throw deleteError;

      return res.json({
        success: true,
        message: "Defaulter work deleted successfully.",
      });
    } catch (err) {
      console.error("Error deleting defaulter work:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

export default router;
