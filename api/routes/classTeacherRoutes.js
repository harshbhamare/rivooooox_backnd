import express from "express";
import multer from "multer";
import xlsx from "xlsx";
import bcrypt from "bcryptjs";
import fs from "fs"
import { supabase } from '../db/supabaseClient.js'
import { authenticateUser, authorizeRoles  } from "../middlewares/auth.js";

// const upload = multer({ dest: "uploads/" });
const calculateDefaulter = (attendance) => attendance < 75;
const router = express.Router();

// Get class/division info for class teacher
router.get('/class-info', authenticateUser, authorizeRoles("class_teacher"), async (req, res) => {
  try {
    const class_id = req.user.class_id;

    if (!class_id) {
      return res.status(400).json({
        success: false,
        error: 'No class assigned to this teacher'
      });
    }

    // Fetch class details from classes table
    const { data: classData, error } = await supabase
      .from('classes')
      .select('id, name, year, department_id')
      .eq('id', class_id)
      .single();

    if (error) throw error;

    if (!classData) {
      return res.status(404).json({
        success: false,
        error: 'Class not found'
      });
    }

    return res.json({
      success: true,
      class: {
        id: classData.id,
        name: classData.name,
        division: classData.name, // Division is the class name
        year: classData.year,
        department_id: classData.department_id
      }
    });
  } catch (err) {
    console.error('Error fetching class info:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get all faculties (all users except directors)
router.get('/faculties', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const { data: faculties, error } = await supabase
      .from('users')
      .select('id, name, email, role')
      .neq('role', 'director')
      .order('name', { ascending: true });

    if (error) throw error;

    return res.json({ success: true, faculties });
  } catch (err) {
    console.error('Error fetching faculties:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/students', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const classId = req.user.class_id;
    console.log('User from token:', req.user);
    if (!classId) {
      console.error('Missing class_id in token. User:', req.user);
      return res.status(400).json({ 
        success: false, 
        error: 'Missing class_id in token. Please ensure your account is assigned to a class.' 
      });
    }

    //  Select with JOIN on batches (Supabase foreign table syntax)
    const { data, error } = await supabase
      .from('students')
      .select(`
        id,
        roll_no,
        name,
        email,
        mobile,
        attendance_percent,
        hall_ticket_number,
        defaulter,
        class_id,
        batch_id,
        created_at,
        batches ( name )
      `)
      .eq('class_id', classId)
      .order('roll_no', { ascending: true });

    if (error) throw error;

    const studentIds = (data || []).map(s => s.id);

    // Get all subjects for this class
    const { data: classSubjects, error: subjectsError } = await supabase
      .from('subjects')
      .select('id, type')
      .eq('class_id', classId);

    if (subjectsError) {
      console.error('Error fetching subjects:', subjectsError);
    }

    // Also get elective subjects that students in this class have selected
    const { data: electiveSelections, error: electiveError } = await supabase
      .from('student_subject_selection')
      .select('student_id, mdm_id, oe_id, pe_id')
      .in('student_id', studentIds);

    if (electiveError) {
      console.error('Error fetching elective selections:', electiveError);
    }

    // Collect unique elective subject IDs
    const electiveSubjectIds = new Set();
    (electiveSelections || []).forEach(selection => {
      if (selection.mdm_id) electiveSubjectIds.add(selection.mdm_id);
      if (selection.oe_id) electiveSubjectIds.add(selection.oe_id);
      if (selection.pe_id) electiveSubjectIds.add(selection.pe_id);
    });

    // Fetch elective subject details
    let electiveSubjects = [];
    if (electiveSubjectIds.size > 0) {
      const { data: eSubjects, error: eSubjectsError } = await supabase
        .from('subjects')
        .select('id, type')
        .in('id', Array.from(electiveSubjectIds));

      if (eSubjectsError) {
        console.error('Error fetching elective subjects:', eSubjectsError);
      } else {
        electiveSubjects = eSubjects || [];
      }
    }

    // Combine class subjects and elective subjects
    const allSubjects = [...(classSubjects || []), ...electiveSubjects];
    
    // Create a map for student -> elective subjects
    const studentElectiveMap = new Map();
    (electiveSelections || []).forEach(selection => {
      const studentElectives = [];
      if (selection.mdm_id) studentElectives.push(selection.mdm_id);
      if (selection.oe_id) studentElectives.push(selection.oe_id);
      if (selection.pe_id) studentElectives.push(selection.pe_id);
      studentElectiveMap.set(selection.student_id, studentElectives);
    });

    // Get all submissions for these students
    const { data: submissions, error: submissionsError } = await supabase
      .from('student_submissions')
      .select('student_id, subject_id, submission_type_id, status')
      .in('student_id', studentIds);

    if (submissionsError) {
      console.error('Error fetching submissions:', submissionsError);
    }

    // Get submission types
    const { data: submissionTypes, error: typesError } = await supabase
      .from('submission_types')
      .select('*');

    if (typesError) {
      console.error('Error fetching submission types:', typesError);
    }

    const taType = (submissionTypes || []).find(t => t.name === 'TA');
    const cieType = (submissionTypes || []).find(t => t.name === 'CIE');

    // Calculate submission percentage for each student based on submission counts
    // Practical subjects: TA only = 1 submission (no CIE, no defaulter work)
    // Theory subjects (including electives): CIE + TA = 2 submissions (+ Defaulter if defaulter student = 3)
    const students = (data || []).map(s => {
      const isDefaulter = s.defaulter;
      const studentSubmissions = (submissions || []).filter(sub => sub.student_id === s.id);
      
      // Get subjects for this student: class subjects + their selected electives
      const studentElectives = studentElectiveMap.get(s.id) || [];
      const studentSubjects = [
        ...(classSubjects || []),
        ...electiveSubjects.filter(es => studentElectives.includes(es.id))
      ];

      if (studentSubjects.length === 0) {
        return {
          ...s,
          batch_name: s.batches?.name || null,
          submission_percentage: 0
        };
      }
      
      let totalSubmissions = 0;
      let completedSubmissions = 0;

      studentSubjects.forEach(subject => {
        const subjectSubmissions = studentSubmissions.filter(sub => sub.subject_id === subject.id);
        
        let subjectTotal = 0;
        let subjectCompleted = 0;

        if (subject.type === 'practical') {
          // Practical subjects: ONLY TA counts (no CIE, no defaulter work)
          subjectTotal = 1;
          const taSubmission = subjectSubmissions.find(sub => sub.submission_type_id === taType?.id);
          subjectCompleted += (taSubmission && taSubmission.status === 'completed' ? 1 : 0);
        } else {
          // Theory subjects (including electives): CIE + TA
          subjectTotal = 2;
          const taSubmission = subjectSubmissions.find(sub => sub.submission_type_id === taType?.id);
          const cieSubmission = subjectSubmissions.find(sub => sub.submission_type_id === cieType?.id);
          subjectCompleted += (taSubmission && taSubmission.status === 'completed' ? 1 : 0);
          subjectCompleted += (cieSubmission && cieSubmission.status === 'completed' ? 1 : 0);
          
          // Add defaulter work ONLY for theory subjects if student is defaulter
          if (isDefaulter) {
            subjectTotal += 1;
            const defaulterType = (submissionTypes || []).find(t => t.name === 'Defaulter work');
            const defaulterSubmission = subjectSubmissions.find(sub => sub.submission_type_id === defaulterType?.id);
            subjectCompleted += (defaulterSubmission && defaulterSubmission.status === 'completed' ? 1 : 0);
          }
        }

        totalSubmissions += subjectTotal;
        completedSubmissions += subjectCompleted;
      });

      const submissionPercentage = totalSubmissions > 0 ? Math.round((completedSubmissions / totalSubmissions) * 100) : 0;

      return {
        ...s,
        batch_name: s.batches?.name || null,
        submission_percentage: submissionPercentage
      };
    });

    return res.json({ success: true, students });
  } catch (err) {
    console.error('Error fetching students:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/batches', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const classId = req.user.class_id;
    if (!classId) {
      console.error('Missing class_id in token. User:', req.user);
      return res.status(400).json({ 
        success: false, 
        error: 'Missing class_id in token. Please ensure your account is assigned to a class.' 
      });
    }

    const { data, error } = await supabase
      .from('batches')
      .select('id, name, roll_start, roll_end, faculty_id, class_id')
      .eq('class_id', classId)
      .order('name', { ascending: true });

    if (error) throw error;

    return res.json({ success: true, batches: data || [] });
  } catch (err) {
    console.error('Error fetching batches:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


router.put("/student/:id", authenticateUser, authorizeRoles("class_teacher", "faculty"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const classId = req.user.class_id;

      // Extract editable fields only
      const {
        name,
        roll_no,
        email,
        mobile,
        attendance_percent,
        hall_ticket_number,
        batch_id,
        defaulter, // optional override
        electiveSelections // MDM, OE, PE selections
      } = req.body;

      if (!id || !classId) {
        return res.status(400).json({ success: false, error: "Missing student ID or class ID" });
      }

      // Fetch the student to confirm same class
      const { data: student, error: fetchError } = await supabase
        .from("students")
        .select("id, class_id")
        .eq("id", id)
        .single();

      if (fetchError || !student) {
        return res.status(404).json({ success: false, error: "Student not found" });
      }

      if (student.class_id !== classId) {
        return res.status(403).json({ success: false, error: "Unauthorized to edit this student" });
      }

      const finalDefaulter =
        typeof defaulter === "boolean"
          ? defaulter
          : Number(attendance_percent) < 75;

      const { data: updated, error: updateError } = await supabase
        .from("students")
        .update({
          name,
          roll_no,
          email,
          mobile,
          attendance_percent,
          hall_ticket_number,
          batch_id,
          defaulter: finalDefaulter,
        })
        .eq("id", id)
        .select()
        .single();

      if (updateError) throw updateError;

      // Update elective selections if provided
      if (electiveSelections) {
        const { mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id } = electiveSelections;
        
        // Check if student has existing selections
        const { data: existing, error: existingError } = await supabase
          .from("student_subject_selection")
          .select("*")
          .eq("student_id", id)
          .maybeSingle();

        if (existingError) throw existingError;

        const selectionsData = {
          mdm_id: mdm_id || null,
          oe_id: oe_id || null,
          pe_id: pe_id || null,
          mdm_faculty_id: mdm_faculty_id || null,
          oe_faculty_id: oe_faculty_id || null,
          pe_faculty_id: pe_faculty_id || null
        };

        if (existing) {
          // Update existing selections
          const { error: updateSelectionsError } = await supabase
            .from("student_subject_selection")
            .update(selectionsData)
            .eq("student_id", id);

          if (updateSelectionsError) throw updateSelectionsError;
        } else {
          // Insert new selections
          const { error: insertSelectionsError } = await supabase
            .from("student_subject_selection")
            .insert([{ student_id: id, ...selectionsData, selections_locked: false }]);

          if (insertSelectionsError) throw insertSelectionsError;
        }
      }

      res.status(200).json({
        success: true,
        message: "Student updated successfully",
        student: updated,
      });
    } catch (err) {
      console.error("Update student error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.delete("/student/:id", authenticateUser, authorizeRoles("class_teacher", "faculty"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const classId = req.user.class_id;

      if (!id || !classId) {
        return res.status(400).json({ success: false, error: "Missing student ID or class ID" });
      }

      // Confirm same class ownership
      const { data: student, error: fetchError } = await supabase
        .from("students")
        .select("id, class_id")
        .eq("id", id)
        .single();

      if (fetchError || !student) {
        return res.status(404).json({ success: false, error: "Student not found" });
      }

      if (student.class_id !== classId) {
        return res.status(403).json({ success: false, error: "Unauthorized to delete this student" });
      }

      const { error: deleteError } = await supabase
        .from("students")
        .delete()
        .eq("id", id);

      if (deleteError) throw deleteError;

      res.status(200).json({ success: true, message: "Student deleted successfully" });
    } catch (err) {
      console.error("Delete student error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.post("/subjects/assign", authenticateUser, authorizeRoles("class_teacher", "faculty"),
  async (req, res) => {
    try {
      
      const {
        class_id,
        subject_code,
        subject_name,
        type, // 'theory' | 'practical'
        faculty_id, // for theory
        faculty_assignments, // array for practical: [{batch_id, faculty_id}]
      } = req.body;

      if (!class_id || !subject_code || !subject_name || !type) {
        console.error('Missing required fields:', { class_id, subject_code, subject_name, type });
        return res
          .status(400)
          .json({ success: false, error: "Missing required fields." });
      }

      // Get department_id from the class
      const { data: classData, error: classError } = await supabase
        .from("classes")
        .select("department_id")
        .eq("id", class_id)
        .single();

      if (classError || !classData) {
        console.error('Class not found or error:', classError);
        return res
          .status(400)
          .json({ success: false, error: "Invalid class_id or class not found." });
      }

      const department_id = classData.department_id;

      if (type === "theory" && !faculty_id) {
        return res
          .status(400)
          .json({ success: false, error: "Faculty ID required for theory subject." });
      }

      if (type === "practical" && (!faculty_assignments || !Array.isArray(faculty_assignments))) {
        return res.status(400).json({
          success: false,
          error: "faculty_assignments array required for practical subjects.",
        });
      }
      
      const { data: subjectData, error: subjectError } = await supabase
        .from("subjects")
        .insert([
          {
            name: subject_name,
            subject_code,
            type,
            department_id,
            class_id,
          },
        ])
        .select()
        .single();

      if (subjectError) {
        console.error('Subject insert error:', subjectError);
        throw subjectError;
      }

      const subject_id = subjectData.id;

      let insertData = [];

      if (type === "theory") {
        insertData.push({
          faculty_id,
          subject_id,
          batch_id: null,
          class_id,
        });
      } else if (type === "practical") {
        for (const fa of faculty_assignments) {
          if (!fa.batch_id || !fa.faculty_id) {
            return res.status(400).json({
              success: false,
              error: "Each batch assignment must have batch_id and faculty_id.",
            });
          }

          insertData.push({
            faculty_id: fa.faculty_id,
            subject_id,
            batch_id: fa.batch_id,
            class_id,
          });
        }
      }

      
      const { data: assignedData, error: assignError } = await supabase
        .from("faculty_subjects")
        .insert(insertData)
        .select();

      if (assignError) {
        console.error('Faculty assignment error:', assignError);
        throw assignError;
      }

      res.status(201).json({
        success: true,
        message:
          type === "theory"
            ? "Theory subject created and assigned successfully."
            : "Practical subject created and assigned to all batches successfully.",
        subject: subjectData,
        assignments: assignedData,
      });
    } catch (err) {
      console.error("Error assigning subject:", err);
      res.status(500).json({
        success: false,
        error: err.message || "Internal Server Error",
      });
    }
  }
);

router.post("/create-batch", authenticateUser, authorizeRoles("class_teacher", "hod"), async (req, res) => {
  try {
    const { name, roll_start, roll_end, faculty_id } = req.body;
    const class_id = req.user.class_id; // from token

    if (!class_id) {
      console.error('Class ID missing in token');
      return res.status(403).json({ success: false, error: "Class ID missing in token" });
    }

    if (!name || !roll_start || !roll_end || !faculty_id) {
      console.error('Missing required fields:', { name, roll_start, roll_end, faculty_id });
      return res.status(400).json({ success: false, error: "All fields are required" });
    }

    // 1️Create batch
    const { data: batchData, error: batchError } = await supabase
      .from("batches")
      .insert([{ name, roll_start, roll_end, faculty_id, class_id }])
      .select()
      .single();

    if (batchError) {
      console.error("Batch insert error:", batchError);
      return res.status(500).json({ success: false, error: batchError.message });
    }

    const batch_id = batchData.id;

    // Update students: assign them to this batch

    const { error: studentError } = await supabase
      .from("students")
      .update({ batch_id })
      .gte("roll_no", roll_start)
      .lte("roll_no", roll_end)
      .eq("class_id", class_id);

    if (studentError) {
      console.error("Student update error:", studentError);
      return res.status(500).json({ success: false, error: studentError.message });
    }

    // Link faculty to batch in faculty_subjects

    const { error: facultySubError } = await supabase
      .from("faculty_subjects")
      .insert([{ faculty_id, class_id, batch_id }]);

    if (facultySubError) {
      console.error("Faculty_subject insert error:", facultySubError);
      // Non-critical error, but inform user
    } else {
      console.log('Faculty linked to batch');
    }

    return res.status(200).json({
      success: true,
      message: "Batch created and faculty linked successfully",
      batch: batchData,
    });
  } catch (err) {
    console.error("Create batch error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/import-students", authenticateUser, authorizeRoles("class_teacher", "faculty"),
  // upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ success: false, error: "No file uploaded" });

      const workbook = xlsx.readFile(req.file.path);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(sheet);

      if (!data.length)
        return res.status(400).json({ success: false, error: "Excel sheet is empty" });

      const required = ["roll_no", "name", "hall_ticket_number", "attendance_percent"];
      const missing = required.filter((c) => !Object.keys(data[0]).includes(c));
      if (missing.length)
        return res.status(400).json({
          success: false,
          error: `Missing required columns: ${missing.join(", ")}`,
        });

      const classId = req.user.class_id || req.body.class_id;
      if (!classId)
        return res
          .status(403)
          .json({ success: false, error: "class_id missing" });

      // Fetch existing students for that class
      const { data: existing, error: fetchError } = await supabase
        .from("students")
        .select("roll_no, hall_ticket_number")
        .eq("class_id", classId);

      if (fetchError) throw fetchError;

      const existingRolls = new Set(existing.map((s) => s.roll_no.toString().trim()));
      const existingHallTickets = new Set(
        existing.map((s) => s.hall_ticket_number.toString().trim())
      );

      // Filter out duplicates
      const newStudents = data.filter((s) => {
        const roll = s.roll_no?.toString().trim();
        const hall = s.hall_ticket_number?.toString().trim();
        return !existingRolls.has(roll) && !existingHallTickets.has(hall);
      });

      if (!newStudents.length) {
        fs.unlinkSync(req.file.path);
        return res.status(200).json({
          success: true,
          message: "No new students to import (all duplicates skipped).",
        });
      }

      // Prepare students for insert
      const students = newStudents.map((s) => {
        const attendance = Number(s.attendance_percent) || 0;
        const hallticket = String(s.hall_ticket_number).trim();
        const hash = bcrypt.hashSync(hallticket, 10);
        return {
          roll_no: String(s.roll_no).trim(),
          name: s.name.trim(),
          hall_ticket_number: hallticket,
          attendance_percent: attendance,
          defaulter: attendance < 75,
          class_id: classId,
          batch_id: null,
          password: hash,
        };
      });

      // Insert only unique new records
      const { error: insertError } = await supabase
        .from("students")
        .insert(students);

      if (insertError) throw insertError;

      fs.unlinkSync(req.file.path);

      res.status(200).json({
        success: true,
        message: `Import completed. ${students.length} new students added.`,
      });
    } catch (err) {
      console.error("Import error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);


// Get subjects for class teacher/faculty
router.get('/subjects', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let subjects = { theory: [], practical: [] };

    if (userRole === 'faculty') {
      // For faculty, get subjects from faculty_subjects table
      const { data: facultySubjects, error } = await supabase
        .from('faculty_subjects')
        .select(`
          subjects (
            id,
            name,
            subject_code,
            type
          )
        `)
        .eq('faculty_id', userId);

      if (error) throw error;

      const subjectIds = new Set();

      // Collect all subjects first
      const allSubjects = [];
      
      // Add subjects from faculty_subjects table
      (facultySubjects || []).forEach(fs => {
        if (fs.subjects && !subjectIds.has(fs.subjects.id)) {
          subjectIds.add(fs.subjects.id);
          allSubjects.push({
            id: fs.subjects.id,
            name: fs.subjects.name,
            code: fs.subjects.subject_code,
            type: fs.subjects.type
          });
        }
      });

      // Also fetch elective subjects from department_offered_subjects
      const { data: offeredSubjects, error: offeredError } = await supabase
        .from('department_offered_subjects')
        .select(`
          subject_id,
          faculty_ids,
          subjects (
            id,
            name,
            subject_code,
            type
          )
        `)
        .contains('faculty_ids', [userId]);

      if (offeredError) throw offeredError;

      // Add offered subjects (all types)
      (offeredSubjects || []).forEach(offered => {
        const subject = offered.subjects;
        if (subject && !subjectIds.has(subject.id)) {
          subjectIds.add(subject.id);
          allSubjects.push({
            id: subject.id,
            name: subject.name,
            code: subject.subject_code,
            type: subject.type
          });
        }
      });

      // Also fetch elective subjects from student selections
      const { data: electiveSelections, error: electiveError } = await supabase
        .from('student_subject_selection')
        .select(`
          mdm_id,
          oe_id,
          pe_id,
          mdm_faculty_id,
          oe_faculty_id,
          pe_faculty_id
        `)
        .or(`mdm_faculty_id.eq.${userId},oe_faculty_id.eq.${userId},pe_faculty_id.eq.${userId}`);

      if (electiveError) throw electiveError;

      // Collect unique elective subject IDs
      const electiveSubjectIds = new Set();
      (electiveSelections || []).forEach(selection => {
        if (selection.mdm_faculty_id === userId && selection.mdm_id && !subjectIds.has(selection.mdm_id)) {
          electiveSubjectIds.add(selection.mdm_id);
        }
        if (selection.oe_faculty_id === userId && selection.oe_id && !subjectIds.has(selection.oe_id)) {
          electiveSubjectIds.add(selection.oe_id);
        }
        if (selection.pe_faculty_id === userId && selection.pe_id && !subjectIds.has(selection.pe_id)) {
          electiveSubjectIds.add(selection.pe_id);
        }
      });

      // Fetch elective subject details
      if (electiveSubjectIds.size > 0) {
        const { data: electiveSubjects, error: electiveSubjectsError } = await supabase
          .from('subjects')
          .select('id, name, subject_code, type')
          .in('id', Array.from(electiveSubjectIds));

        if (electiveSubjectsError) throw electiveSubjectsError;

        // Add elective subjects
        (electiveSubjects || []).forEach(subject => {
          if (!subjectIds.has(subject.id)) {
            subjectIds.add(subject.id);
            allSubjects.push({
              id: subject.id,
              name: subject.name,
              code: subject.subject_code,
              type: subject.type
            });
          }
        });
      }

      // Now separate by type - practical goes to practical array, everything else to theory
      subjects.theory = allSubjects.filter(s => s.type !== 'practical');
      subjects.practical = allSubjects.filter(s => s.type === 'practical');
    } else {
      // For class teachers, get subjects for their class only
      const class_id = req.user.class_id;

      if (!class_id) {
        return res.status(400).json({
          success: false,
          error: 'No class assigned to this teacher'
        });
      }

      const { data: allSubjects, error } = await supabase
        .from('subjects')
        .select('id, name, subject_code, type')
        .eq('class_id', class_id);

      if (error) throw error;

      // Separate by type - practical goes to practical array, everything else to theory
      subjects.theory = (allSubjects || [])
        .filter(s => s.type !== 'practical')
        .map(s => ({
          id: s.id,
          name: s.name,
          code: s.subject_code
        }));
      
      subjects.practical = (allSubjects || [])
        .filter(s => s.type === 'practical')
        .map(s => ({
          id: s.id,
          name: s.name,
          code: s.subject_code
        }));
    }

    return res.json({ success: true, subjects });
  } catch (err) {
    console.error('Error fetching subjects:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get teacher availability status
router.get('/availability', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get all availability records for this faculty
    const { data, error } = await supabase
      .from('faculty_availability')
      .select('is_available')
      .eq('faculty_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error fetching availability:', error);
      throw error;
    }


    return res.json({ 
      success: true, 
      isAvailable: data?.is_available || false 
    });
  } catch (err) {
    console.error('Error fetching availability:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Update teacher availability status for selected subjects
router.put('/availability', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { isAvailable, selectedSubjects } = req.body;

    if (!Array.isArray(selectedSubjects)) {
      return res.status(400).json({ 
        success: false, 
        error: 'selectedSubjects must be an array' 
      });
    }

    // Delete all existing availability records for this faculty
    const { error: deleteError } = await supabase
      .from('faculty_availability')
      .delete()
      .eq('faculty_id', userId);

    if (deleteError) {
      console.error('Error deleting old records:', deleteError);
      throw deleteError;
    }

    // If available and subjects are selected, insert new records
    if (isAvailable && selectedSubjects.length > 0) {
      // selectedSubjects contains subject codes, we need to get subject IDs
      const { data: subjects, error: subjectsError } = await supabase
        .from('subjects')
        .select('id, subject_code')
        .in('subject_code', selectedSubjects);

      if (subjectsError) {
        console.error(' Error fetching subjects:', subjectsError);
        throw subjectsError;
      }

      if (!subjects || subjects.length === 0) {
        console.error('No subjects found for codes:', selectedSubjects);
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid subject codes' 
        });
      }

      const availabilityRecords = subjects.map(subject => ({
        faculty_id: userId,
        subject_id: subject.id,
        is_available: true,
        updated_at: new Date().toISOString()
      }));

      const { error: insertError } = await supabase
        .from('faculty_availability')
        .insert(availabilityRecords);

      if (insertError) {
        console.error('Error inserting availability records:', insertError);
        throw insertError;
      }
    } else {
      console.log('Availability set to offline (no subjects)');
    }

    return res.json({ 
      success: true, 
      isAvailable,
      selectedSubjects
    });
  } catch (err) {
    console.error('Error updating availability:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get available subjects for a faculty
router.get('/available-subjects', authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const userId = req.user.id;
    
    
    const { data, error } = await supabase
      .from('faculty_availability')
      .select(`
        subject_id,
        is_available,
        subjects (
          subject_code
        )
      `)
      .eq('faculty_id', userId)
      .eq('is_available', true);

    if (error) {
      console.error('Error fetching available subjects:', error);
      throw error;
    }

    const availableSubjects = (data || [])
      .filter(record => record.subjects)
      .map(record => record.subjects.subject_code);
    const isAvailable = availableSubjects.length > 0;

    return res.json({ 
      success: true, 
      isAvailable,
      selectedSubjects: availableSubjects
    });
  } catch (err) {
    console.error('Error fetching available subjects:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get elective subjects for a student (class teacher)
router.get("/elective-subjects/:studentId", authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const { studentId } = req.params;
    const class_id = req.user.class_id;

    // Verify student belongs to teacher's class
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("class_id")
      .eq("id", studentId)
      .single();

    if (studentError || !student) {
      return res.status(404).json({
        success: false,
        error: "Student not found"
      });
    }

    if (student.class_id !== class_id) {
      return res.status(403).json({
        success: false,
        error: "You can only view students in your class"
      });
    }

    // Get class info
    const { data: classInfo, error: classError } = await supabase
      .from("classes")
      .select("year, department_id")
      .eq("id", class_id)
      .single();

    if (classError) throw classError;

    // Get offered subjects for this year
    const { data: offeredSubjects, error: offeredError } = await supabase
      .from("department_offered_subjects")
      .select(`
        id,
        subject_id,
        department_id,
        faculty_ids,
        subjects (
          id,
          name,
          subject_code,
          type
        )
      `)
      .eq("year", classInfo.year)
      .eq("is_active", true);

    if (offeredError) throw offeredError;

    // Get faculty names
    const allFacultyIds = [...new Set(offeredSubjects.flatMap(os => os.faculty_ids || []))];
    const { data: faculties, error: facultiesError } = await supabase
      .from("users")
      .select("id, name")
      .in("id", allFacultyIds);

    if (facultiesError) throw facultiesError;

    const facultyMap = new Map(faculties.map(f => [f.id, f.name]));

    // Get student's current selections
    const { data: currentSelections, error: selectionsError } = await supabase
      .from("student_subject_selection")
      .select("*")
      .eq("student_id", studentId)
      .maybeSingle();

    if (selectionsError) throw selectionsError;

    // Organize subjects
    const electiveSubjects = { mdm: [], oe: [], pe: [] };

    offeredSubjects.forEach(offered => {
      const subject = offered.subjects;
      if (!subject) return;

      const facultyOptions = (offered.faculty_ids || []).map(fId => ({
        id: fId,
        name: facultyMap.get(fId) || 'Unknown Faculty'
      }));

      const subjectData = {
        id: subject.id,
        code: subject.subject_code,
        name: subject.name,
        faculties: facultyOptions
      };

      const subjectType = (subject.type || '').toLowerCase();
      const subjectName = (subject.name || '').toLowerCase();

      if (subjectType === 'mdm' || subjectName.includes('multidisciplinary')) {
        electiveSubjects.mdm.push(subjectData);
      } else if (subjectType === 'oe' || subjectName.includes('open elective')) {
        electiveSubjects.oe.push(subjectData);
      } else if (subjectType === 'pe' || subjectName.includes('professional elective')) {
        if (offered.department_id === classInfo.department_id) {
          electiveSubjects.pe.push(subjectData);
        }
      }
    });

    return res.json({
      success: true,
      electives: electiveSubjects,
      currentSelections: currentSelections || {}
    });
  } catch (err) {
    console.error("Error fetching elective subjects:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Unlock student's elective selections (class teacher only)
router.put("/unlock-student-selections/:studentId", authenticateUser, authorizeRoles("class_teacher", "faculty"), async (req, res) => {
  try {
    const { studentId } = req.params;
    const class_id = req.user.class_id;

    // Verify student belongs to teacher's class
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("class_id")
      .eq("id", studentId)
      .single();

    if (studentError || !student) {
      return res.status(404).json({
        success: false,
        error: "Student not found"
      });
    }

    if (student.class_id !== class_id) {
      return res.status(403).json({
        success: false,
        error: "You can only unlock selections for students in your class"
      });
    }

    // Unlock selections
    const { error: updateError } = await supabase
      .from("student_subject_selection")
      .update({ selections_locked: false })
      .eq("student_id", studentId);

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: "Student's elective selections have been unlocked"
    });
  } catch (err) {
    console.error("Error unlocking selections:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Delete subject
router.delete("/subjects/:id", authenticateUser, authorizeRoles("class_teacher"), async (req, res) => {
  try {
    const { id } = req.params;
    const classId = req.user.class_id;

    if (!classId) {
      return res.status(400).json({ success: false, error: "Missing class_id in token" });
    }

    // Verify subject belongs to this class
    const { data: subject, error: subjectError } = await supabase
      .from("subjects")
      .select("id, class_id")
      .eq("id", id)
      .single();

    if (subjectError || !subject) {
      return res.status(404).json({ success: false, error: "Subject not found" });
    }

    if (subject.class_id !== classId) {
      return res.status(403).json({ success: false, error: "Unauthorized to delete this subject" });
    }

    // Delete faculty_subjects first (cascade or manual)
    const { error: deleteFacultySubjectsError } = await supabase
      .from("faculty_subjects")
      .delete()
      .eq("subject_id", id);

    if (deleteFacultySubjectsError) {
      console.error("Error deleting faculty_subjects:", deleteFacultySubjectsError);
    }

    // Delete subject
    const { error: deleteError } = await supabase
      .from("subjects")
      .delete()
      .eq("id", id);

    if (deleteError) throw deleteError;

    res.status(200).json({ success: true, message: "Subject deleted successfully" });
  } catch (err) {
    console.error("Error deleting subject:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
