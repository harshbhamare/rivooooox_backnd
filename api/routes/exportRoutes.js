import express from "express";
import { supabase } from '../db/supabaseClient.js';
import { authenticateUser, authorizeRoles } from "../middlewares/auth.js";

const router = express.Router();

// Export class data for class teacher
router.get('/class-data', authenticateUser, authorizeRoles("class_teacher"), async (req, res) => {
  try {
    const class_id = req.user.class_id;

    if (!class_id) {
      return res.status(400).json({
        success: false,
        error: 'No class assigned to this teacher'
      });
    }

    console.log('📊 Exporting data for class:', class_id);

    // Get class information
    const { data: classInfo, error: classError } = await supabase
      .from('classes')
      .select('name, year, department_id')
      .eq('id', class_id)
      .single();

    if (classError) throw classError;

    // Get all students in the class
    const { data: students, error: studentsError } = await supabase
      .from('students')
      .select('id, roll_no, name, defaulter, batch_id, batches(name)')
      .eq('class_id', class_id)
      .order('roll_no', { ascending: true });

    if (studentsError) throw studentsError;

    console.log('📊 Students found:', students?.length || 0);

    // Get all class subjects
    const { data: classSubjects, error: subjectsError } = await supabase
      .from('subjects')
      .select('id, name, subject_code, type')
      .eq('class_id', class_id)
      .order('name', { ascending: true });

    if (subjectsError) throw subjectsError;

    // Get elective selections for students
    const studentIds = students.map(s => s.id);
    const { data: electiveSelections, error: electiveError } = await supabase
      .from('student_subject_selection')
      .select('student_id, mdm_id, oe_id, pe_id')
      .in('student_id', studentIds);

    if (electiveError) throw electiveError;

    // Get unique elective subject IDs
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
        .select('id, name, subject_code, type')
        .in('id', Array.from(electiveSubjectIds))
        .order('name', { ascending: true });

      if (eSubjectsError) throw eSubjectsError;
      electiveSubjects = eSubjects || [];
    }

    // Create student -> electives map
    const studentElectiveMap = new Map();
    (electiveSelections || []).forEach(selection => {
      const electives = [];
      if (selection.mdm_id) electives.push(selection.mdm_id);
      if (selection.oe_id) electives.push(selection.oe_id);
      if (selection.pe_id) electives.push(selection.pe_id);
      studentElectiveMap.set(selection.student_id, electives);
    });

    // Get all submissions
    const { data: submissions, error: submissionsError } = await supabase
      .from('student_submissions')
      .select('student_id, subject_id, submission_type_id, status')
      .in('student_id', studentIds);

    if (submissionsError) throw submissionsError;

    // Get submission types
    const { data: submissionTypes, error: typesError } = await supabase
      .from('submission_types')
      .select('*');

    if (typesError) throw typesError;

    const taType = submissionTypes.find(t => t.name === 'TA');
    const cieType = submissionTypes.find(t => t.name === 'CIE');
    const defaulterType = submissionTypes.find(t => t.name === 'Defaulter work');

    // Prepare data for export
    const exportData = {
      classInfo: {
        name: classInfo.name,
        year: classInfo.year
      },
      students: students.map(student => {
        const studentElectives = studentElectiveMap.get(student.id) || [];
        const allSubjects = [
          ...classSubjects,
          ...electiveSubjects.filter(es => studentElectives.includes(es.id))
        ];

        const subjectSubmissions = {};
        allSubjects.forEach(subject => {
          const subs = submissions.filter(s => 
            s.student_id === student.id && s.subject_id === subject.id
          );

          const taSubmission = subs.find(s => s.submission_type_id === taType?.id);
          const cieSubmission = subs.find(s => s.submission_type_id === cieType?.id);
          const defaulterSubmission = subs.find(s => s.submission_type_id === defaulterType?.id);

          subjectSubmissions[subject.id] = {
            subject_name: subject.name,
            subject_code: subject.subject_code,
            subject_type: subject.type,
            cie: subject.type === 'practical' ? 'N/A' : (cieSubmission?.status || 'pending'),
            ta: taSubmission?.status || 'pending',
            defaulter: student.defaulter && subject.type !== 'practical' 
              ? (defaulterSubmission?.status || 'pending') 
              : '-'
          };
        });

        return {
          roll_no: student.roll_no,
          name: student.name,
          batch: student.batches?.name || '-',
          defaulter: student.defaulter,
          submissions: subjectSubmissions
        };
      }),
      subjects: [
        ...classSubjects.map(s => ({
          id: s.id,
          name: s.name,
          code: s.subject_code,
          type: s.type
        })),
        ...electiveSubjects.map(s => ({
          id: s.id,
          name: s.name,
          code: s.subject_code,
          type: s.type,
          isElective: true
        }))
      ]
    };

    console.log('📊 Export data prepared successfully');

    return res.json({
      success: true,
      data: exportData
    });

  } catch (err) {
    console.error('Error exporting class data:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
