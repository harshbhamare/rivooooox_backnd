import express from "express";
import { supabase } from '../db/supabaseClient.js';
import { authenticateUser, authorizeRoles } from "../middlewares/auth.js";

const router = express.Router();

// Get subjects assigned to the faculty
router.get('/subjects', authenticateUser, authorizeRoles("faculty"), async (req, res) => {
  try {
    const facultyId = req.user.id;

    // Fetch subjects assigned to this faculty from faculty_subjects table
    const { data: facultySubjects, error } = await supabase
      .from('faculty_subjects')
      .select(`
        subject_id,
        subjects (
          id,
          name,
          subject_code,
          type
        )
      `)
      .eq('faculty_id', facultyId);

    if (error) throw error;

    // Extract unique subjects
    const uniqueSubjects = [];
    const subjectIds = new Set();

    (facultySubjects || []).forEach(fs => {
      if (fs.subjects && !subjectIds.has(fs.subjects.id)) {
        subjectIds.add(fs.subjects.id);
        uniqueSubjects.push({
          id: fs.subjects.id,
          name: fs.subjects.name,
          code: fs.subjects.subject_code,
          type: fs.subjects.type
        });
      }
    });

    // Also fetch elective subjects from department_offered_subjects where faculty_ids contains this faculty
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
      .contains('faculty_ids', [facultyId]);

    if (offeredError) throw offeredError;

    // Add offered subjects (all types)
    (offeredSubjects || []).forEach(offered => {
      const subject = offered.subjects;
      if (subject && !subjectIds.has(subject.id)) {
        subjectIds.add(subject.id);
        uniqueSubjects.push({
          id: subject.id,
          name: subject.name,
          code: subject.subject_code,
          type: subject.type
        });
      }
    });

    // Also fetch elective subjects (OE, PE, MDM) where this faculty is assigned via student selections
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
      .or(`mdm_faculty_id.eq.${facultyId},oe_faculty_id.eq.${facultyId},pe_faculty_id.eq.${facultyId}`);

    if (electiveError) throw electiveError;

    // Collect unique elective subject IDs where this faculty is assigned
    const electiveSubjectIds = new Set();
    (electiveSelections || []).forEach(selection => {
      if (selection.mdm_faculty_id === facultyId && selection.mdm_id) {
        electiveSubjectIds.add(selection.mdm_id);
      }
      if (selection.oe_faculty_id === facultyId && selection.oe_id) {
        electiveSubjectIds.add(selection.oe_id);
      }
      if (selection.pe_faculty_id === facultyId && selection.pe_id) {
        electiveSubjectIds.add(selection.pe_id);
      }
    });

    // Fetch elective subject details from student selections
    if (electiveSubjectIds.size > 0) {
      const { data: electiveSubjects, error: electiveSubjectsError } = await supabase
        .from('subjects')
        .select('id, name, subject_code, type')
        .in('id', Array.from(electiveSubjectIds));

      if (electiveSubjectsError) throw electiveSubjectsError;

      // Add elective subjects to the list
      (electiveSubjects || []).forEach(subject => {
        if (!subjectIds.has(subject.id)) {
          subjectIds.add(subject.id);
          uniqueSubjects.push({
            id: subject.id,
            name: subject.name,
            code: subject.subject_code,
            type: subject.type
          });
        }
      });
    }

    return res.json({ success: true, subjects: uniqueSubjects });
  } catch (err) {
    console.error('Error fetching faculty subjects:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get students for subjects assigned to the faculty
router.get('/students', authenticateUser, authorizeRoles("faculty"), async (req, res) => {
  try {
    const facultyId = req.user.id;

    // First, get all subject-batch assignments for this faculty
    const { data: assignments, error: assignError } = await supabase
      .from('faculty_subjects')
      .select(`
        subject_id,
        batch_id,
        class_id,
        subjects (
          id,
          name,
          subject_code,
          type
        )
      `)
      .eq('faculty_id', facultyId);

    if (assignError) throw assignError;

    // Get all students from the classes where faculty teaches
    const classIds = [...new Set((assignments || []).map(a => a.class_id).filter(Boolean))];
    
    let allStudents = [];
    if (classIds.length > 0) {
      const { data: students, error: studentsError } = await supabase
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
        .in('class_id', classIds)
        .order('roll_no', { ascending: true });

      if (studentsError) throw studentsError;
      allStudents = students || [];
    }

    // Map students to their subjects based on assignments
    const studentsWithSubjects = [];

    allStudents.forEach(student => {
      // Find all subject assignments for this student
      (assignments || []).forEach(assignment => {
        // Check if this assignment applies to this student
        const isApplicable = 
          assignment.class_id === student.class_id &&
          (assignment.batch_id === null || assignment.batch_id === student.batch_id);

        if (isApplicable && assignment.subjects) {
          studentsWithSubjects.push({
            ...student,
            batch_name: student.batches?.name || null,
            subject_id: assignment.subjects.id,
            subject_name: assignment.subjects.name,
            subject_code: assignment.subjects.subject_code,
            subject_type: assignment.subjects.type
          });
        }
      });
    });

    // Also get students who have selected elective subjects taught by this faculty
    const { data: electiveSelections, error: electiveError } = await supabase
      .from('student_subject_selection')
      .select(`
        student_id,
        mdm_id,
        oe_id,
        pe_id,
        mdm_faculty_id,
        oe_faculty_id,
        pe_faculty_id
      `)
      .or(`mdm_faculty_id.eq.${facultyId},oe_faculty_id.eq.${facultyId},pe_faculty_id.eq.${facultyId}`);

    if (electiveError) throw electiveError;

    // Get unique student IDs from elective selections
    const electiveStudentIds = [...new Set((electiveSelections || []).map(s => s.student_id))];

    if (electiveStudentIds.length > 0) {
      // Fetch student details
      const { data: electiveStudents, error: electiveStudentsError } = await supabase
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
        .in('id', electiveStudentIds)
        .order('roll_no', { ascending: true });

      if (electiveStudentsError) throw electiveStudentsError;

      // Get subject IDs for electives
      const electiveSubjectIds = new Set();
      (electiveSelections || []).forEach(selection => {
        if (selection.mdm_faculty_id === facultyId && selection.mdm_id) {
          electiveSubjectIds.add(selection.mdm_id);
        }
        if (selection.oe_faculty_id === facultyId && selection.oe_id) {
          electiveSubjectIds.add(selection.oe_id);
        }
        if (selection.pe_faculty_id === facultyId && selection.pe_id) {
          electiveSubjectIds.add(selection.pe_id);
        }
      });

      // Fetch elective subject details
      const { data: electiveSubjects, error: electiveSubjectsError } = await supabase
        .from('subjects')
        .select('id, name, subject_code, type')
        .in('id', Array.from(electiveSubjectIds));

      if (electiveSubjectsError) throw electiveSubjectsError;

      // Create a map of subject details
      const subjectMap = new Map();
      (electiveSubjects || []).forEach(subject => {
        subjectMap.set(subject.id, subject);
      });

      // Map elective students to their subjects
      (electiveStudents || []).forEach(student => {
        const selection = electiveSelections.find(s => s.student_id === student.id);
        if (!selection) return;

        // Add student for each elective subject they selected with this faculty
        if (selection.mdm_faculty_id === facultyId && selection.mdm_id) {
          const subject = subjectMap.get(selection.mdm_id);
          if (subject) {
            studentsWithSubjects.push({
              ...student,
              batch_name: student.batches?.name || null,
              subject_id: subject.id,
              subject_name: subject.name,
              subject_code: subject.subject_code,
              subject_type: subject.type
            });
          }
        }

        if (selection.oe_faculty_id === facultyId && selection.oe_id) {
          const subject = subjectMap.get(selection.oe_id);
          if (subject) {
            studentsWithSubjects.push({
              ...student,
              batch_name: student.batches?.name || null,
              subject_id: subject.id,
              subject_name: subject.name,
              subject_code: subject.subject_code,
              subject_type: subject.type
            });
          }
        }

        if (selection.pe_faculty_id === facultyId && selection.pe_id) {
          const subject = subjectMap.get(selection.pe_id);
          if (subject) {
            studentsWithSubjects.push({
              ...student,
              batch_name: student.batches?.name || null,
              subject_id: subject.id,
              subject_name: subject.name,
              subject_code: subject.subject_code,
              subject_type: subject.type
            });
          }
        }
      });
    }

    return res.json({ success: true, students: studentsWithSubjects });
  } catch (err) {
    console.error('Error fetching faculty students:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
