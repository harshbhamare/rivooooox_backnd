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

    // Get all student IDs to fetch their submissions
    const allStudentIds = allStudents.map(s => s.id);
    
    console.log('📊 Faculty students endpoint - Faculty ID:', facultyId);
    console.log('📊 Total students found:', allStudents.length);
    console.log('📊 Student IDs:', allStudentIds.slice(0, 5));
    
    // Fetch all submissions for these students
    let submissions = [];
    if (allStudentIds.length > 0) {
      const { data: submissionsData, error: submissionsError } = await supabase
        .from('student_submissions')
        .select('student_id, subject_id, submission_type_id, status')
        .in('student_id', allStudentIds);

      if (submissionsError) {
        console.error('❌ Error fetching submissions:', submissionsError);
        throw submissionsError;
      }
      submissions = submissionsData || [];
      console.log('📊 Total submissions found:', submissions.length);
      console.log('📊 Sample submissions:', JSON.stringify(submissions.slice(0, 5), null, 2));
      
      // Check unique statuses
      const uniqueStatuses = [...new Set(submissions.map(s => s.status))];
      console.log('📊 Unique status values in database:', uniqueStatuses);
    } else {
      console.log('⚠️ No students found, skipping submission fetch');
    }

    // Get submission types
    const { data: submissionTypes, error: typesError } = await supabase
      .from('submission_types')
      .select('*');

    if (typesError) throw typesError;

    const taType = (submissionTypes || []).find(t => t.name === 'TA');
    const cieType = (submissionTypes || []).find(t => t.name === 'CIE');
    const defaulterType = (submissionTypes || []).find(t => t.name === 'Defaulter work');
    
    console.log('📊 Submission types:', {
      TA: taType?.id,
      CIE: cieType?.id,
      Defaulter: defaulterType?.id
    });

    // Log subject IDs from assignments vs submissions
    const assignmentSubjectIds = [...new Set((assignments || []).map(a => a.subjects?.id).filter(Boolean))];
    const submissionSubjectIds = [...new Set(submissions.map(s => s.subject_id))];
    console.log('📊 Faculty assigned to subject IDs:', assignmentSubjectIds);
    console.log('📊 Submissions exist for subject IDs:', submissionSubjectIds);
    console.log('📊 Matching subject IDs:', assignmentSubjectIds.filter(id => submissionSubjectIds.includes(id)));

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
          // Get submissions for this student and subject
          const studentSubjectSubmissions = submissions.filter(
            sub => sub.student_id === student.id && sub.subject_id === assignment.subjects.id
          );

          const taSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === taType?.id);
          const cieSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === cieType?.id);
          const defaulterSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === defaulterType?.id);

          const studentData = {
            ...student,
            batch_name: student.batches?.name || null,
            subject_id: assignment.subjects.id,
            subject_name: assignment.subjects.name,
            subject_code: assignment.subjects.subject_code,
            subject_type: assignment.subjects.type,
            ta_status: taSubmission?.status || 'pending',
            cie_status: cieSubmission?.status || 'pending',
            defaulter_status: defaulterSubmission?.status || 'pending'
          };

          // Log first student for debugging
          if (studentsWithSubjects.length === 0) {
            console.log('📊 First student-subject mapping:', {
              student_id: student.id,
              student_name: student.name,
              subject_id: assignment.subjects.id,
              subject_name: assignment.subjects.name,
              subject_type: assignment.subjects.type,
              submissions_found: studentSubjectSubmissions.length,
              all_submissions_for_student: submissions.filter(s => s.student_id === student.id).length,
              student_submission_subject_ids: submissions.filter(s => s.student_id === student.id).map(s => s.subject_id),
              ta_status: studentData.ta_status,
              cie_status: studentData.cie_status,
              defaulter_status: studentData.defaulter_status
            });
          }

          studentsWithSubjects.push(studentData);
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

      // Fetch submissions for elective students
      const { data: electiveSubmissions, error: electiveSubmissionsError } = await supabase
        .from('student_submissions')
        .select('student_id, subject_id, submission_type_id, status')
        .in('student_id', electiveStudentIds);

      if (electiveSubmissionsError) throw electiveSubmissionsError;

      // Map elective students to their subjects
      (electiveStudents || []).forEach(student => {
        const selection = electiveSelections.find(s => s.student_id === student.id);
        if (!selection) return;

        // Add student for each elective subject they selected with this faculty
        if (selection.mdm_faculty_id === facultyId && selection.mdm_id) {
          const subject = subjectMap.get(selection.mdm_id);
          if (subject) {
            const studentSubjectSubmissions = (electiveSubmissions || []).filter(
              sub => sub.student_id === student.id && sub.subject_id === subject.id
            );

            const taSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === taType?.id);
            const cieSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === cieType?.id);
            const defaulterSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === defaulterType?.id);

            studentsWithSubjects.push({
              ...student,
              batch_name: student.batches?.name || null,
              subject_id: subject.id,
              subject_name: subject.name,
              subject_code: subject.subject_code,
              subject_type: subject.type,
              ta_status: taSubmission?.status || 'pending',
              cie_status: cieSubmission?.status || 'pending',
              defaulter_status: defaulterSubmission?.status || 'pending'
            });
          }
        }

        if (selection.oe_faculty_id === facultyId && selection.oe_id) {
          const subject = subjectMap.get(selection.oe_id);
          if (subject) {
            const studentSubjectSubmissions = (electiveSubmissions || []).filter(
              sub => sub.student_id === student.id && sub.subject_id === subject.id
            );

            const taSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === taType?.id);
            const cieSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === cieType?.id);
            const defaulterSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === defaulterType?.id);

            studentsWithSubjects.push({
              ...student,
              batch_name: student.batches?.name || null,
              subject_id: subject.id,
              subject_name: subject.name,
              subject_code: subject.subject_code,
              subject_type: subject.type,
              ta_status: taSubmission?.status || 'pending',
              cie_status: cieSubmission?.status || 'pending',
              defaulter_status: defaulterSubmission?.status || 'pending'
            });
          }
        }

        if (selection.pe_faculty_id === facultyId && selection.pe_id) {
          const subject = subjectMap.get(selection.pe_id);
          if (subject) {
            const studentSubjectSubmissions = (electiveSubmissions || []).filter(
              sub => sub.student_id === student.id && sub.subject_id === subject.id
            );

            const taSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === taType?.id);
            const cieSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === cieType?.id);
            const defaulterSubmission = studentSubjectSubmissions.find(sub => sub.submission_type_id === defaulterType?.id);

            studentsWithSubjects.push({
              ...student,
              batch_name: student.batches?.name || null,
              subject_id: subject.id,
              subject_name: subject.name,
              subject_code: subject.subject_code,
              subject_type: subject.type,
              ta_status: taSubmission?.status || 'pending',
              cie_status: cieSubmission?.status || 'pending',
              defaulter_status: defaulterSubmission?.status || 'pending'
            });
          }
        }
      });
    }

    // Calculate submission percentage for each student-subject pair
    const studentsWithPercentages = studentsWithSubjects.map((student, index) => {
      let totalSubmissions = 0;
      let completedSubmissions = 0;

      if (student.subject_type === 'practical') {
        // Practical: only TA counts
        totalSubmissions = 1;
        completedSubmissions += (student.ta_status === 'completed' ? 1 : 0);
      } else {
        // Theory: CIE + TA
        totalSubmissions = 2;
        completedSubmissions += (student.cie_status === 'completed' ? 1 : 0);
        completedSubmissions += (student.ta_status === 'completed' ? 1 : 0);
        
        // Add defaulter work ONLY for theory subjects if student is defaulter
        if (student.defaulter) {
          totalSubmissions += 1;
          completedSubmissions += (student.defaulter_status === 'completed' ? 1 : 0);
        }
      }

      const submissionPercentage = totalSubmissions > 0 ? Math.round((completedSubmissions / totalSubmissions) * 100) : 0;

      // Log first 3 students for debugging
      if (index < 3) {
        console.log(`📊 Student ${index + 1} percentage calculation:`, {
          name: student.name,
          subject: student.subject_name,
          type: student.subject_type,
          is_defaulter: student.defaulter,
          ta_status: student.ta_status,
          cie_status: student.cie_status,
          defaulter_status: student.defaulter_status,
          total: totalSubmissions,
          completed: completedSubmissions,
          percentage: submissionPercentage
        });
      }

      return {
        ...student,
        submission_percentage: submissionPercentage,
        total_submissions: totalSubmissions,
        completed_submissions: completedSubmissions
      };
    });

    // Find students with actual submissions to show as examples
    const studentsWithSubmissions = studentsWithPercentages.filter(s => s.completed_submissions > 0);
    
    console.log('📊 Total student-subject pairs to return:', studentsWithPercentages.length);
    console.log('📊 Students with submissions:', studentsWithSubmissions.length);
    console.log('📊 Sample student data with percentages:', studentsWithPercentages.slice(0, 2).map(s => ({
      name: s.name,
      subject: s.subject_name,
      type: s.subject_type,
      ta: s.ta_status,
      cie: s.cie_status,
      defaulter_status: s.defaulter_status,
      is_defaulter: s.defaulter,
      percentage: s.submission_percentage,
      completed: s.completed_submissions,
      total: s.total_submissions
    })));
    
    if (studentsWithSubmissions.length > 0) {
      console.log('📊 Sample students WITH submissions:', studentsWithSubmissions.slice(0, 3).map(s => ({
        name: s.name,
        subject: s.subject_name,
        subject_id: s.subject_id,
        type: s.subject_type,
        ta: s.ta_status,
        cie: s.cie_status,
        percentage: s.submission_percentage,
        completed: s.completed_submissions,
        total: s.total_submissions
      })));
    }

    return res.json({ success: true, students: studentsWithPercentages });
  } catch (err) {
    console.error('Error fetching faculty students:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
