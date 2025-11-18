import express from 'express'
import { supabase } from '../db/supabaseClient.js'
import { authenticateUser, authorizeRoles } from "../middlewares/auth.js";

const router = express.Router()

// Test endpoint to debug authentication
router.get("/debug-auth", authenticateUser, authorizeRoles("student"), async (req, res) => {
  try {
    console.log('Debug auth - Full req.user:', req.user);

    const student_id = req.user.id;

    // Check if student exists
    const { data: student, error } = await supabase
      .from("students")
      .select("id, name, hall_ticket_number, class_id, batch_id")
      .eq("id", student_id)
      .maybeSingle();

    // Get all students to compare
    const { data: allStudents } = await supabase
      .from("students")
      .select("id, name, hall_ticket_number")
      .limit(10);

    return res.json({
      success: true,
      tokenData: req.user,
      studentFound: !!student,
      studentData: student,
      error: error,
      sampleStudents: allStudents
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Public endpoint to check students (for debugging only - remove in production)
router.get("/debug-students", async (req, res) => {
  try {
    const { data: students } = await supabase
      .from("students")
      .select("id, name, hall_ticket_number, class_id, batch_id")
      .limit(5);

    return res.json({
      success: true,
      students: students
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get student dashboard data
router.get("/dashboard", authenticateUser, authorizeRoles("student"), async (req, res) => {
  try {
    const student_id = req.user.id;
    const class_id = req.user.class_id;
    const batch_id = req.user.batch_id;

    console.log('Student dashboard request:', { student_id, class_id, batch_id });
    console.log('Full user object from token:', JSON.stringify(req.user, null, 2));

    if (!student_id) {
      console.error('❌ Missing student_id in token');
      return res.status(400).json({
        success: false,
        error: "Missing student_id in token",
        debug: { tokenData: req.user }
      });
    }

    // Get student basic info first to check if class_id exists in database
    console.log('Searching for student with ID:', student_id);
    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("*")
      .eq("id", student_id)
      .maybeSingle();

    console.log('Student query result:', { student, studentError });

    if (studentError) {
      console.error('Student fetch error:', studentError);
      throw studentError;
    }

    if (!student) {
      console.log('❌ No student found with ID:', student_id);
      return res.status(404).json({
        success: false,
        error: "Student not found"
      });
    }

    // Check if student has class_id
    const studentClassId = student.class_id || class_id;
    if (!studentClassId) {
      console.error('❌ Student has no class_id assigned:', student.name);
      return res.status(400).json({
        success: false,
        error: "You are not assigned to a class yet. Please contact your administrator.",
        studentInfo: {
          name: student.name,
          rollNumber: student.roll_no
        }
      });
    }

    // Get subjects for this student's class
    // For theory subjects: all subjects in the class
    // For practical subjects: only subjects assigned to student's batch

    // Get all subjects for the class
    const { data: allSubjects, error: subjectsError } = await supabase
      .from("subjects")
      .select("id, name, subject_code, type, class_id")
      .eq("class_id", studentClassId);

    if (subjectsError) throw subjectsError;

    // Get faculty_subjects to determine which subjects are available to this student
    const { data: facultySubjects, error: fsError } = await supabase
      .from("faculty_subjects")
      .select("subject_id, batch_id")
      .eq("class_id", studentClassId);

    if (fsError) throw fsError;

    // Filter subjects based on type and batch
    const subjects = allSubjects.filter(subject => {
      if (subject.type === 'theory') {
        // Theory subjects are available to all students in the class
        return true;
      } else if (subject.type === 'practical') {
        // Practical subjects are only available if assigned to student's batch
        return facultySubjects.some(fs =>
          fs.subject_id === subject.id &&
          (fs.batch_id === batch_id || fs.batch_id === null)
        );
      }
      return false;
    });

    // Also add elective subjects that the student has selected
    const { data: studentSelections, error: selectionsError } = await supabase
      .from("student_subject_selection")
      .select("mdm_id, oe_id, pe_id")
      .eq("student_id", student_id)
      .maybeSingle();

    if (selectionsError) throw selectionsError;

    // Get elective subject IDs
    const electiveSubjectIds = [];
    if (studentSelections) {
      if (studentSelections.mdm_id) electiveSubjectIds.push(studentSelections.mdm_id);
      if (studentSelections.oe_id) electiveSubjectIds.push(studentSelections.oe_id);
      if (studentSelections.pe_id) electiveSubjectIds.push(studentSelections.pe_id);
    }

    // Fetch elective subject details and add to subjects array
    if (electiveSubjectIds.length > 0) {
      const { data: electiveSubjects, error: electiveError } = await supabase
        .from("subjects")
        .select("id, name, subject_code, type")
        .in("id", electiveSubjectIds);

      if (electiveError) throw electiveError;

      // Add elective subjects to the subjects array
      (electiveSubjects || []).forEach(elective => {
        if (!subjects.find(s => s.id === elective.id)) {
          subjects.push({
            id: elective.id,
            name: elective.name,
            subject_code: elective.subject_code,
            type: elective.type,
            class_id: studentClassId
          });
        }
      });
    }

    // Get student submissions for all subjects
    const { data: submissions, error: submissionsError } = await supabase
      .from("student_submissions")
      .select("subject_id, submission_type_id, status")
      .eq("student_id", student_id);

    if (submissionsError) throw submissionsError;

    // Get submission types separately
    const { data: submissionTypes, error: typesError } = await supabase
      .from("submission_types")
      .select("id, name");

    if (typesError) throw typesError;

    // Create a map of submission type IDs to names
    const typeMap = new Map();
    submissionTypes.forEach(type => {
      typeMap.set(type.id, type.name);
    });

    // Get faculty availability for subjects
    const subjectIds = subjects.map(s => s.id);
    const { data: facultyAvailability, error: availabilityError } = await supabase
      .from("faculty_availability")
      .select("subject_id, is_available")
      .in("subject_id", subjectIds);

    if (availabilityError) throw availabilityError;

    // Create availability map
    const availabilityMap = new Map();
    facultyAvailability?.forEach(fa => {
      availabilityMap.set(fa.subject_id, fa.is_available);
    });

    // Map submissions to subjects
    const subjectsWithSubmissions = subjects.map(subject => {
      const subjectSubmissions = submissions.filter(s => s.subject_id === subject.id);
      const submissionMap = {
        CIE: 'pending',
        TA: 'pending',
        'Defaulter work': 'pending'
      };

      subjectSubmissions.forEach(sub => {
        const typeName = typeMap.get(sub.submission_type_id);
        if (typeName) {
          submissionMap[typeName] = sub.status;
        }
      });

      return {
        id: subject.id,
        code: subject.subject_code,
        name: subject.name,
        type: subject.type,
        facultyAvailable: availabilityMap.get(subject.id) || false,
        submissions: {
          cie: submissionMap.CIE,
          ta: submissionMap.TA,
          defaulter: submissionMap['Defaulter work']
        }
      };
    });

    // Calculate submission percentage (exclude defaulter work for non-defaulter students)
    const isDefaulter = student.defaulter;
    const submissionsPerSubject = isDefaulter ? 3 : 2; // CIE, TA, and optionally Defaulter work
    const totalSubmissions = subjectsWithSubmissions.length * submissionsPerSubject;

    const completedSubmissions = subjectsWithSubmissions.reduce((count, subject) => {
      let subjectCompleted = 0;
      subjectCompleted += (subject.submissions.cie === 'completed' ? 1 : 0);
      subjectCompleted += (subject.submissions.ta === 'completed' ? 1 : 0);

      // Only count defaulter work for defaulter students
      if (isDefaulter) {
        subjectCompleted += (subject.submissions.defaulter === 'completed' ? 1 : 0);
      }

      return count + subjectCompleted;
    }, 0);

    const submissionPercentage = totalSubmissions > 0 ? Math.round((completedSubmissions / totalSubmissions) * 100) : 0;

    console.log('Dashboard data prepared:', {
      studentName: student.name,
      subjectsCount: subjectsWithSubmissions.length,
      submissionPercentage,
      totalSubmissions,
      completedSubmissions
    });

    return res.json({
      success: true,
      student: {
        id: student.id,
        name: student.name,
        rollNumber: student.roll_no,
        hallTicket: student.hall_ticket_number,
        email: student.email,
        contact: student.mobile,
        defaulter: student.defaulter,
        attendancePercent: student.attendance_percent,
        submissionPercentage
      },
      subjects: subjectsWithSubmissions
    });
  } catch (err) {
    console.error("Error fetching student dashboard:", err);
    console.error("Error details:", {
      message: err.message,
      code: err.code,
      details: err.details,
      hint: err.hint
    });
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
      details: process.env.NODE_ENV === 'development' ? err.details : undefined
    });
  }
});

// Get all subjects for student (theory, practical, MDM, OE, PE)
router.get("/subjects", authenticateUser, authorizeRoles("student"), async (req, res) => {
  try {
    const student_id = req.user.id;
    const class_id = req.user.class_id;
    const batch_id = req.user.batch_id;

    console.log('Student subjects request:', { student_id, class_id, batch_id });

    if (!student_id) {
      return res.status(400).json({
        success: false,
        error: "Missing student_id in token"
      });
    }

    if (!class_id) {
      return res.status(400).json({
        success: false,
        error: "You are not assigned to a class yet. Please contact your administrator."
      });
    }

    // Get class information including year
    const { data: classInfo, error: classError } = await supabase
      .from("classes")
      .select("year")
      .eq("id", class_id)
      .maybeSingle();

    if (classError) throw classError;

    const classYear = classInfo?.year || 1;

    // Get all subjects for the class
    const { data: allSubjects, error: subjectsError } = await supabase
      .from("subjects")
      .select("id, name, subject_code, type, class_id")
      .eq("class_id", class_id);

    if (subjectsError) throw subjectsError;

    // Get faculty assignments for subjects
    const { data: facultySubjects, error: fsError } = await supabase
      .from("faculty_subjects")
      .select(`
        subject_id,
        faculty_id,
        batch_id,
        class_id,
        users (
          name
        )
      `)
      .eq("class_id", class_id);

    if (fsError) throw fsError;

    // Get faculty names separately to avoid relationship issues
    const facultyIds = [...new Set(facultySubjects.map(fs => fs.faculty_id).filter(Boolean))];
    const { data: faculties, error: facultiesError } = await supabase
      .from("users")
      .select("id, name")
      .in("id", facultyIds);

    if (facultiesError) throw facultiesError;

    const facultyMap = new Map(faculties.map(f => [f.id, f.name]));

    // Get student's subject selections (MDM, OE, PE)
    const { data: studentSelections, error: selectionsError } = await supabase
      .from("student_subject_selection")
      .select("mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id")
      .eq("student_id", student_id)
      .maybeSingle();

    if (selectionsError) throw selectionsError;

    // Organize subjects by type
    const subjectsByType = {
      theory: [],
      practical: [],
      mdm: [],
      oe: [],
      pe: []
    };

    // Get faculty availability for all subjects
    const allSubjectIds = allSubjects.map(s => s.id);
    const { data: facultyAvailability, error: availabilityError } = await supabase
      .from("faculty_availability")
      .select("subject_id, is_available")
      .in("subject_id", allSubjectIds);

    if (availabilityError) throw availabilityError;

    // Create availability map
    const availabilityMap = new Map();
    facultyAvailability?.forEach(fa => {
      availabilityMap.set(fa.subject_id, fa.is_available);
    });

    // Process theory and practical subjects
    allSubjects.forEach(subject => {
      const assignments = facultySubjects.filter(fs => fs.subject_id === subject.id);

      if (subject.type === 'theory') {
        const assignment = assignments[0];
        subjectsByType.theory.push({
          id: subject.id,
          code: subject.subject_code,
          name: subject.name,
          faculty: assignment ? (facultyMap.get(assignment.faculty_id) || 'Not assigned') : 'Not assigned',
          facultyAvailable: availabilityMap.get(subject.id) || false
        });
      } else if (subject.type === 'practical') {
        // Check if this practical subject is assigned to student's batch
        const batchAssignment = assignments.find(a => a.batch_id === batch_id);
        if (batchAssignment) {
          subjectsByType.practical.push({
            id: subject.id,
            code: subject.subject_code,
            name: subject.name,
            faculty: facultyMap.get(batchAssignment.faculty_id) || 'Not assigned',
            batch: batch_id,
            facultyAvailable: availabilityMap.get(subject.id) || false
          });
        }
      }
    });

    // Get selected elective subjects from subjects table (not limited to class)
    const electiveSubjectIds = [];
    if (studentSelections) {
      if (studentSelections.mdm_id) electiveSubjectIds.push(studentSelections.mdm_id);
      if (studentSelections.oe_id) electiveSubjectIds.push(studentSelections.oe_id);
      if (studentSelections.pe_id) electiveSubjectIds.push(studentSelections.pe_id);
    }

    let electiveSubjects = [];
    if (electiveSubjectIds.length > 0) {
      const { data: electiveSubjectsData, error: electiveError } = await supabase
        .from("subjects")
        .select("id, name, subject_code, type")
        .in("id", electiveSubjectIds);

      if (electiveError) throw electiveError;
      electiveSubjects = electiveSubjectsData || [];
    }

    // Get faculty names for elective subjects
    const electiveFacultyIds = [];
    if (studentSelections) {
      if (studentSelections.mdm_faculty_id) electiveFacultyIds.push(studentSelections.mdm_faculty_id);
      if (studentSelections.oe_faculty_id) electiveFacultyIds.push(studentSelections.oe_faculty_id);
      if (studentSelections.pe_faculty_id) electiveFacultyIds.push(studentSelections.pe_faculty_id);
    }

    if (electiveFacultyIds.length > 0) {
      const { data: electiveFaculties, error: electiveFacultiesError } = await supabase
        .from("users")
        .select("id, name")
        .in("id", electiveFacultyIds);

      if (electiveFacultiesError) throw electiveFacultiesError;

      // Add elective faculty to the main faculty map
      electiveFaculties.forEach(f => {
        facultyMap.set(f.id, f.name);
      });
    }

    // Add selected elective subjects based on class year
    // Year 2: OE and MDM only
    // Year 3: OE, PE, and MDM
    // Year 4: OE and PE only
    if (studentSelections) {
      // MDM - Show for Year 2 and Year 3
      if ((classYear === 2 || classYear === 3) && studentSelections.mdm_id) {
        const mdmSubject = electiveSubjects.find(s => s.id === studentSelections.mdm_id);
        if (mdmSubject) {
          subjectsByType.mdm.push({
            id: mdmSubject.id,
            code: mdmSubject.subject_code,
            name: mdmSubject.name,
            faculty: facultyMap.get(studentSelections.mdm_faculty_id) || 'Not assigned',
            description: 'Multidisciplinary Minor'
          });
        }
      }

      // OE - Show for Year 2, Year 3, and Year 4
      if ((classYear === 2 || classYear === 3 || classYear === 4) && studentSelections.oe_id) {
        const oeSubject = electiveSubjects.find(s => s.id === studentSelections.oe_id);
        if (oeSubject) {
          subjectsByType.oe.push({
            id: oeSubject.id,
            code: oeSubject.subject_code,
            name: oeSubject.name,
            faculty: facultyMap.get(studentSelections.oe_faculty_id) || 'Not assigned',
            description: 'Open Elective'
          });
        }
      }

      // PE - Show for Year 3 and Year 4
      if ((classYear === 3 || classYear === 4) && studentSelections.pe_id) {
        const peSubject = electiveSubjects.find(s => s.id === studentSelections.pe_id);
        if (peSubject) {
          subjectsByType.pe.push({
            id: peSubject.id,
            code: peSubject.subject_code,
            name: peSubject.name,
            faculty: facultyMap.get(studentSelections.pe_faculty_id) || 'Not assigned',
            description: 'Professional Elective'
          });
        }
      }
    }

    console.log('Subjects organized:', {
      theory: subjectsByType.theory.length,
      practical: subjectsByType.practical.length,
      mdm: subjectsByType.mdm.length,
      oe: subjectsByType.oe.length,
      pe: subjectsByType.pe.length
    });

    return res.json({
      success: true,
      subjects: subjectsByType
    });
  } catch (err) {
    console.error("Error fetching student subjects:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get available elective subjects (MDM, OE, PE) for student
router.get("/elective-subjects", authenticateUser, authorizeRoles("student"), async (req, res) => {
  try {
    const student_id = req.user.id;
    const class_id = req.user.class_id;

    console.log('Student elective subjects request:', { student_id, class_id });

    // Get student's class information to determine year
    const { data: classInfo, error: classError } = await supabase
      .from("classes")
      .select("year, department_id")
      .eq("id", class_id)
      .maybeSingle();

    if (classError) {
      console.error('Class fetch error:', classError);
      throw classError;
    }

    if (!classInfo) {
      return res.status(404).json({
        success: false,
        error: "Class not found"
      });
    }

    const { year, department_id } = classInfo;

    // Get all offered subjects for this year
    const { data: offeredSubjects, error: offeredError } = await supabase
      .from("department_offered_subjects")
      .select(`
        id,
        subject_id,
        semester,
        year,
        department_id,
        faculty_ids,
        subjects (
          id,
          name,
          subject_code,
          type
        )
      `)
      .eq("year", year)
      .eq("is_active", true);

    console.log('📚 Offered subjects found:', offeredSubjects?.length || 0);
    console.log('📚 Subject types:', offeredSubjects?.map(os => ({ 
      name: os.subjects?.name, 
      type: os.subjects?.type,
      dept_id: os.department_id
    })));

    if (offeredError) throw offeredError;

    // Get all faculty members
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
      .select("mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id, selections_locked")
      .eq("student_id", student_id)
      .maybeSingle();

    if (selectionsError) throw selectionsError;

    // Organize subjects by type based on class year
    // Year 2: OE and MDM only
    // Year 3: OE, PE, and MDM
    // Year 4: OE and PE only
    const electiveSubjects = {
      mdm: [],
      oe: [],
      pe: []
    };

    offeredSubjects.forEach(offered => {
      const subject = offered.subjects;
      if (!subject) return;

      // Prepare faculty options
      const facultyOptions = (offered.faculty_ids || []).map(fId => ({
        id: fId,
        name: facultyMap.get(fId) || 'Unknown Faculty'
      }));

      const subjectData = {
        id: subject.id,
        code: subject.subject_code,
        name: subject.name,
        semester: offered.semester,
        faculties: facultyOptions
      };

      // Categorize subjects - check type field (case insensitive)
      const subjectType = (subject.type || '').toLowerCase();
      const subjectName = (subject.name || '').toLowerCase();
      
      // MDM - Show for Year 2 and Year 3
      if ((year === 2 || year === 3) && (subjectType === 'mdm' || subjectName.includes('multidisciplinary') || subjectName.includes('mdm'))) {
        electiveSubjects.mdm.push(subjectData);
        console.log('✅ Added MDM subject:', subject.name);
      } 
      // OE - Show for Year 2, Year 3, and Year 4
      else if ((year === 2 || year === 3 || year === 4) && (subjectType === 'oe' || subjectName.includes('open elective') || subjectName.includes('oe'))) {
        electiveSubjects.oe.push(subjectData);
        console.log('✅ Added OE subject:', subject.name);
      } 
      // PE - Show for Year 3 and Year 4
      else if ((year === 3 || year === 4) && (subjectType === 'pe' || subjectName.includes('professional elective') || subjectName.includes('pe'))) {
        // For PE, only show subjects from student's department
        if (offered.department_id === department_id) {
          electiveSubjects.pe.push(subjectData);
          console.log('✅ Added PE subject:', subject.name);
        } else {
          console.log('⏭️ Skipped PE subject (different department):', subject.name);
        }
      } else {
        console.log('⏭️ Subject not shown for year', year, ':', subject.name, 'Type:', subject.type);
      }
    });

    console.log('Elective subjects organized:', {
      mdm: electiveSubjects.mdm.length,
      oe: electiveSubjects.oe.length,
      pe: electiveSubjects.pe.length
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

// Get defaulter work for student
router.get("/defaulter-work", authenticateUser, authorizeRoles("student"), async (req, res) => {
  try {
    const student_id = req.user.id;

    console.log('📋 Fetching defaulter work for student:', student_id);

    // Get student's elective selections
    const { data: studentSelections, error: selectionsError } = await supabase
      .from("student_subject_selection")
      .select("mdm_id, oe_id, pe_id, mdm_faculty_id, oe_faculty_id, pe_faculty_id")
      .eq("student_id", student_id)
      .maybeSingle();

    if (selectionsError) throw selectionsError;

    // Get defaulter work assigned to this student
    const { data: defaulterWork, error } = await supabase
      .from("defaulter_submissions")
      .select(`
        id,
        subject_id,
        faculty_id,
        submission_text,
        reference_link,
        created_at,
        skip,
        status,
        subjects (
          name,
          subject_code,
          type
        )
      `)
      .eq("student_id", student_id)
      .eq("skip", false)
      .order("created_at", { ascending: false });

    if (error) throw error;

    console.log('📋 Defaulter work found:', defaulterWork?.length || 0);

    // Filter defaulter work to only show:
    // 1. Regular subjects (theory, practical) - show all
    // 2. Elective subjects (mdm, oe, pe) - only show if student selected that faculty for that subject
    const filteredWork = (defaulterWork || []).filter(work => {
      const subjectType = (work.subjects?.type || '').toLowerCase();
      
      // For regular subjects, show all
      if (subjectType === 'theory' || subjectType === 'practical') {
        return true;
      }
      
      // For elective subjects, only show if student selected this faculty for this subject
      if (!studentSelections) return false;
      
      if (subjectType === 'mdm' || subjectType === 'oe' || subjectType === 'pe') {
        // Check if this work is for a subject the student selected with this faculty
        if (work.subject_id === studentSelections.mdm_id && work.faculty_id === studentSelections.mdm_faculty_id) {
          return true;
        }
        if (work.subject_id === studentSelections.oe_id && work.faculty_id === studentSelections.oe_faculty_id) {
          return true;
        }
        if (work.subject_id === studentSelections.pe_id && work.faculty_id === studentSelections.pe_faculty_id) {
          return true;
        }
        return false;
      }
      
      // For any other type, show it
      return true;
    });

    console.log('📋 Filtered defaulter work:', filteredWork.length);
    console.log('📋 Student selections:', studentSelections);

    const formattedWork = filteredWork.map(work => ({
      id: work.id,
      subjectCode: work.subjects?.subject_code || 'N/A',
      subjectName: work.subjects?.name || 'Unknown Subject',
      description: work.submission_text,
      referenceLink: work.reference_link,
      assignedDate: work.created_at,
      status: work.status || 'pending'
    }));

    console.log('📋 Formatted defaulter work:', formattedWork.length);

    return res.json({
      success: true,
      defaulterWork: formattedWork
    });
  } catch (err) {
    console.error("Error fetching defaulter work:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post(
  "/select-elective",
  authenticateUser,
  authorizeRoles("student"),
  async (req, res) => {
    try {
      const { subject_id, faculty_id, type } = req.body;
      const student_id = req.user.id;

      if (!subject_id || !faculty_id || !type) {
        return res.status(400).json({
          success: false,
          error: "subject_id, faculty_id, and type are required.",
        });
      }

      if (!["MDM", "OE", "PE"].includes(type)) {
        return res.status(400).json({
          success: false,
          error: "Invalid type. Must be one of: MDM, OE, or PE.",
        });
      }

      // Check if selections are locked
      const { data: existing, error: existingError } = await supabase
        .from("student_subject_selection")
        .select("*")
        .eq("student_id", student_id)
        .maybeSingle();

      if (existingError) throw existingError;

      if (existing && existing.selections_locked) {
        return res.status(403).json({
          success: false,
          error: "Your subject selections are locked. Contact your class teacher to make changes.",
        });
      }

      // Verify that faculty teaches this subject
      const { data: facultySubject, error: fsError } = await supabase
        .from("faculty_subjects")
        .select("subject_id, faculty_id")
        .eq("subject_id", subject_id)
        .eq("faculty_id", faculty_id)
        .maybeSingle();

      if (fsError || !facultySubject) {
        return res.status(400).json({
          success: false,
          error: "Selected faculty does not teach the given subject.",
        });
      }

      // Prepare update payload based on type
      let updateData = {};
      if (type === "MDM") {
        updateData = { mdm_id: subject_id, mdm_faculty_id: faculty_id };
      } else if (type === "OE") {
        updateData = { oe_id: subject_id, oe_faculty_id: faculty_id };
      } else if (type === "PE") {
        updateData = { pe_id: subject_id, pe_faculty_id: faculty_id };
      }

      // Insert or update
      if (existing) {
        const { error: updateError } = await supabase
          .from("student_subject_selection")
          .update(updateData)
          .eq("student_id", student_id);
        if (updateError) throw updateError;

        return res.status(200).json({
          success: true,
          message: `${type} subject selection updated successfully.`,
        });
      } else {
        const { error: insertError } = await supabase
          .from("student_subject_selection")
          .insert([{ student_id, ...updateData, selections_locked: false }]);
        if (insertError) throw insertError;

        return res.status(201).json({
          success: true,
          message: `${type} subject selected successfully.`,
        });
      }
    } catch (err) {
      console.error("❌ Error selecting elective:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Lock student's elective selections
router.post(
  "/lock-selections",
  authenticateUser,
  authorizeRoles("student"),
  async (req, res) => {
    try {
      const student_id = req.user.id;
      const class_id = req.user.class_id;

      // Get class year to determine which electives are required
      const { data: classInfo, error: classError } = await supabase
        .from("classes")
        .select("year")
        .eq("id", class_id)
        .maybeSingle();

      if (classError) throw classError;

      const classYear = classInfo?.year || 1;

      // Check if required subjects are selected based on year
      const { data: selections, error: selectError } = await supabase
        .from("student_subject_selection")
        .select("*")
        .eq("student_id", student_id)
        .maybeSingle();

      if (selectError) throw selectError;

      if (!selections) {
        return res.status(400).json({
          success: false,
          error: "No elective selections found. Please select your elective subjects first.",
        });
      }

      // Validate based on year
      const missingSubjects = [];
      
      // Year 2: OE and MDM required
      if (classYear === 2) {
        if (!selections.oe_id) missingSubjects.push('OE');
        if (!selections.mdm_id) missingSubjects.push('MDM');
      }
      // Year 3: OE, MDM, and PE required
      else if (classYear === 3) {
        if (!selections.oe_id) missingSubjects.push('OE');
        if (!selections.mdm_id) missingSubjects.push('MDM');
        if (!selections.pe_id) missingSubjects.push('PE');
      }
      // Year 4: OE and PE required
      else if (classYear === 4) {
        if (!selections.oe_id) missingSubjects.push('OE');
        if (!selections.pe_id) missingSubjects.push('PE');
      }

      if (missingSubjects.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Please select all required elective subjects (${missingSubjects.join(', ')}) before locking.`,
        });
      }

      // Lock the selections
      const { error: updateError } = await supabase
        .from("student_subject_selection")
        .update({ selections_locked: true })
        .eq("student_id", student_id);

      if (updateError) throw updateError;

      return res.status(200).json({
        success: true,
        message: "Your elective selections have been locked successfully.",
      });
    } catch (err) {
      console.error("❌ Error locking selections:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);





export default router;