import express from 'express'
import { supabase } from '../db/supabaseClient.js'
import { authenticateUser, authorizeRoles } from "../middlewares/auth.js";

const router = express.Router()

// Get subjects assigned to the logged-in faculty
router.get("/faculty-subjects", authenticateUser, authorizeRoles("faculty", "class_teacher", "hod"),
  async (req, res) => {
    try {
      const faculty_id = req.user.id;

      // Get all subjects assigned to this faculty
      const { data: facultySubjects, error: fsError } = await supabase
        .from("faculty_subjects")
        .select(`
          subject_id,
          batch_id,
          class_id,
          subjects (
            id,
            name,
            subject_code,
            type,
            class_id
          )
        `)
        .eq("faculty_id", faculty_id);

      if (fsError) throw fsError;

      // Get batch names for practical subjects
      const batchIds = [...new Set((facultySubjects || []).map(fs => fs.batch_id).filter(Boolean))];
      let batchMap = new Map();

      if (batchIds.length > 0) {
        const { data: batches, error: batchError } = await supabase
          .from("batches")
          .select("id, name")
          .in("id", batchIds);

        if (batchError) throw batchError;
        batchMap = new Map(batches?.map(b => [b.id, b.name]) || []);
      }

      // Group subjects by type
      const subjectMap = new Map();

      (facultySubjects || []).forEach(fs => {
        const subject = fs.subjects;
        if (!subject) return;

        const subjectId = subject.id;

        if (subject.type === "theory") {
          // Theory subjects - one entry per subject
          if (!subjectMap.has(subjectId)) {
            subjectMap.set(subjectId, {
              id: subject.id,
              code: subject.subject_code,
              name: subject.name,
              type: "theory"
            });
          }
        } else if (subject.type === "practical") {
          // Practical subjects - may have multiple batches
          if (!subjectMap.has(subjectId)) {
            subjectMap.set(subjectId, {
              id: subject.id,
              code: subject.subject_code,
              name: subject.name,
              type: "practical",
              batches: []
            });
          }

          // Add batch info
          if (fs.batch_id) {
            const batchName = batchMap.get(fs.batch_id);
            if (batchName) {
              subjectMap.get(subjectId).batches.push({
                batch_id: fs.batch_id,
                batch_name: batchName
              });
            }
          }
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
        .contains('faculty_ids', [faculty_id]);

      if (offeredError) throw offeredError;

      // Add offered subjects to the map (all types)
      (offeredSubjects || []).forEach(offered => {
        const subject = offered.subjects;
        if (!subject) return;

        const subjectId = subject.id;

        if (!subjectMap.has(subjectId)) {
          subjectMap.set(subjectId, {
            id: subject.id,
            code: subject.subject_code,
            name: subject.name,
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
        .or(`mdm_faculty_id.eq.${faculty_id},oe_faculty_id.eq.${faculty_id},pe_faculty_id.eq.${faculty_id}`);

      if (electiveError) throw electiveError;

      // Collect unique elective subject IDs where this faculty is assigned
      const electiveSubjectIds = new Set();
      (electiveSelections || []).forEach(selection => {
        if (selection.mdm_faculty_id === faculty_id && selection.mdm_id) {
          electiveSubjectIds.add(selection.mdm_id);
        }
        if (selection.oe_faculty_id === faculty_id && selection.oe_id) {
          electiveSubjectIds.add(selection.oe_id);
        }
        if (selection.pe_faculty_id === faculty_id && selection.pe_id) {
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

        // Add elective subjects to the map
        (electiveSubjects || []).forEach(subject => {
          if (!subjectMap.has(subject.id)) {
            subjectMap.set(subject.id, {
              id: subject.id,
              code: subject.subject_code,
              name: subject.name,
              type: subject.type || "theory"
            });
          }
        });
      }

      // Convert map to arrays
      const allSubjects = Array.from(subjectMap.values());
      
      // Log for debugging
      console.log('📚 Faculty subjects endpoint - Faculty ID:', faculty_id);
      console.log('📚 Total subjects found:', allSubjects.length);
      console.log('📚 Subject types:', allSubjects.map(s => ({ name: s.name, type: s.type })));
      console.log('📚 Offered subjects count:', offeredSubjects?.length || 0);
      console.log('📚 Elective selections count:', electiveSelections?.length || 0);
      
      // Separate by type - practical goes to practical array, everything else to theory
      const theorySubjects = allSubjects.filter(s => s.type !== "practical");
      const practicalSubjects = allSubjects.filter(s => s.type === "practical");

      console.log('📚 Theory subjects:', theorySubjects.length);
      console.log('📚 Practical subjects:', practicalSubjects.length);

      return res.json({
        success: true,
        subjects: {
          theory: theorySubjects,
          practical: practicalSubjects
        }
      });
    } catch (err) {
      console.error("Error fetching faculty subjects:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Get submission types
router.get("/types", authenticateUser, async (req, res) => {
  try {
    const { data: types, error } = await supabase
      .from("submission_types")
      .select("*")
      .order("name", { ascending: true });

    if (error) throw error;

    return res.json({
      success: true,
      submission_types: types || [],
    });
  } catch (err) {
    console.error("Error fetching submission types:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get students for faculty with their submissions
router.get("/students", authenticateUser, authorizeRoles("faculty", "class_teacher", "hod"),
  async (req, res) => {
    try {
      const faculty_id = req.user.id;
      const { subject_id } = req.query;

      if (!subject_id) {
        return res.status(400).json({
          success: false,
          error: "subject_id is required.",
        });
      }

      // Get students for this subject from multiple sources
      let allStudents = [];
      
      // Check faculty_subjects first
      const { data: facultySubjects, error: fsError } = await supabase
        .from("faculty_subjects")
        .select("class_id, batch_id")
        .eq("faculty_id", faculty_id)
        .eq("subject_id", subject_id);

      if (fsError) throw fsError;

      // Get students from faculty_subjects assignments
      if (facultySubjects && facultySubjects.length > 0) {
        for (const assignment of facultySubjects) {
          let query = supabase
            .from("students")
            .select(`
              id,
              roll_no,
              name,
              email,
              attendance_percent,
              defaulter,
              class_id,
              batch_id
            `)
            .eq("class_id", assignment.class_id)
            .order("roll_no", { ascending: true });

          if (assignment.batch_id) {
            query = query.eq("batch_id", assignment.batch_id);
          }

          const { data: students, error: studentsError } = await query;
          if (!studentsError && students) {
            allStudents.push(...students);
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
            .select(`
              id,
              roll_no,
              name,
              email,
              attendance_percent,
              defaulter,
              class_id,
              batch_id
            `)
            .in('id', electiveStudentIds)
            .order('roll_no', { ascending: true });

          if (!electiveStudentsError && electiveStudents) {
            allStudents.push(...electiveStudents);
          }
        }
      }

      // Remove duplicates based on student id
      const uniqueStudentsMap = new Map();
      allStudents.forEach(student => {
        if (!uniqueStudentsMap.has(student.id)) {
          uniqueStudentsMap.set(student.id, student);
        }
      });
      const students = Array.from(uniqueStudentsMap.values());

      if (students.length === 0) {
        return res.json({
          success: true,
          students: [],
          submission_types: []
        });
      }

      // Get all submissions for these students and this subject
      const studentIds = students.map(s => s.id);
      const { data: submissions, error: submissionsError } = await supabase
        .from("student_submissions")
        .select("student_id, submission_type_id, status")
        .eq("subject_id", subject_id)
        .in("student_id", studentIds);

      if (submissionsError) throw submissionsError;

      // Get submission types
      const { data: submissionTypes, error: typesError } = await supabase
        .from("submission_types")
        .select("*");

      if (typesError) throw typesError;

      // Map submissions to students
      const studentsWithSubmissions = students.map(student => {
        const studentSubmissions = submissions.filter(s => s.student_id === student.id);
        const submissionMap = {};

        studentSubmissions.forEach(sub => {
          const type = submissionTypes.find(t => t.id === sub.submission_type_id);
          if (type) {
            submissionMap[type.name] = sub.status;
          }
        });

        return {
          ...student,
          submissions: submissionMap,
        };
      });

      return res.json({
        success: true,
        students: studentsWithSubmissions,
        submission_types: submissionTypes,
      });
    } catch (err) {
      console.error("Error fetching students:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);


router.post(
  "/mark-submission",
  authenticateUser,
  authorizeRoles("faculty", "class_teacher", "hod"),
  async (req, res) => {
    try {
      const { student_id, subject_id, submission_type, status } = req.body;
      const marked_by = req.user.id;

      // 🧩 1️⃣ Basic validation
      if (!student_id || !subject_id || !submission_type || !status) {
        return res.status(400).json({
          success: false,
          error: "student_id, subject_id, submission_type, and status are required.",
        });
      }

      if (!["pending", "completed"].includes(status.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: "Status must be 'pending' or 'completed'.",
        });
      }

      // 🧩 2️⃣ Verify faculty can actually mark this subject
      const { data: allowedSubject, error: allowedError } = await supabase
        .from("faculty_subjects")
        .select("id")
        .eq("faculty_id", marked_by)
        .eq("subject_id", subject_id)
        .maybeSingle();

      if (allowedError) throw allowedError;
      if (!allowedSubject) {
        return res.status(403).json({
          success: false,
          error: "You are not authorized to mark submissions for this subject.",
        });
      }

      // 🧩 3️⃣ Validate student belongs to same class/batch as faculty
      // (Optional strictness)
      // const { data: studentData } = await supabase
      //   .from("students")
      //   .select("class_id, batch_id")
      //   .eq("id", student_id)
      //   .single();

      // TODO: add logic if you want to ensure class alignment for batch-based subjects

      // 🧩 4️⃣ Fetch submission type ID
      const { data: subType, error: subTypeErr } = await supabase
        .from("submission_types")
        .select("id")
        .eq("name", submission_type)
        .maybeSingle();

      if (subTypeErr) throw subTypeErr;
      if (!subType) {
        return res.status(400).json({
          success: false,
          error: `Invalid submission_type: ${submission_type}.`,
        });
      }

      const submission_type_id = subType.id;

      // 🧩 5️⃣ Check if a record already exists
      const { data: existing, error: existingErr } = await supabase
        .from("student_submissions")
        .select("id")
        .eq("student_id", student_id)
        .eq("subject_id", subject_id)
        .eq("submission_type_id", submission_type_id)
        .maybeSingle();

      if (existingErr) throw existingErr;

      // 🧩 6️⃣ Insert or update accordingly
      if (existing) {
        const { error: updateErr } = await supabase
          .from("student_submissions")
          .update({
            status,
            marked_by,
            marked_at: new Date(),
          })
          .eq("id", existing.id);

        if (updateErr) throw updateErr;

        return res.status(200).json({
          success: true,
          message: `${submission_type} submission updated to ${status} successfully.`,
        });
      } else {
        const { error: insertErr } = await supabase.from("student_submissions").insert([
          {
            student_id,
            subject_id,
            submission_type_id,
            status,
            marked_by,
            marked_at: new Date(),
          },
        ]);

        if (insertErr) throw insertErr;

        return res.status(201).json({
          success: true,
          message: `${submission_type} submission marked as ${status} successfully.`,
        });
      }
    } catch (err) {
      console.error("❌ Error marking submission:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);





// Get dashboard statistics for class teacher
router.get("/dashboard-statistics", authenticateUser, authorizeRoles("faculty", "class_teacher", "hod"),
  async (req, res) => {
    try {
      const class_id = req.user.class_id;

      if (!class_id) {
        return res.status(400).json({
          success: false,
          error: "Class ID not found in token"
        });
      }

      // Get all students in the class
      const { data: students, error: studentsError } = await supabase
        .from("students")
        .select("id, defaulter")
        .eq("class_id", class_id);

      if (studentsError) throw studentsError;

      const totalStudents = students?.length || 0;
      const defaulterStudents = students?.filter(s => s.defaulter).length || 0;

      if (totalStudents === 0) {
        return res.json({
          success: true,
          statistics: {
            overallSubmission: 0,
            submissionMarked: 0,
            defaulterWorkSubmitted: 0,
            totalStudents: 0,
            defaulterCount: 0
          }
        });
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
      const defaulterType = submissionTypes.find(t => t.name === 'Defaulter work');

      // Calculate statistics
      const studentsWithSubmissions = new Set();
      submissions.forEach(sub => {
        if (sub.status === 'completed' && 
            (sub.submission_type_id === taType?.id || sub.submission_type_id === cieType?.id)) {
          studentsWithSubmissions.add(sub.student_id);
        }
      });

      const studentSubmissionMap = {};
      submissions.forEach(sub => {
        if (!studentSubmissionMap[sub.student_id]) {
          studentSubmissionMap[sub.student_id] = {};
        }
        studentSubmissionMap[sub.student_id][sub.submission_type_id] = sub.status;
      });

      const studentsWithBothCompleted = Object.values(studentSubmissionMap).filter(subs => 
        subs[taType?.id] === 'completed' && subs[cieType?.id] === 'completed'
      ).length;

      const defaulterStudentIds = students.filter(s => s.defaulter).map(s => s.id);
      const defaulterStudentsWithWork = new Set();
      
      submissions.forEach(sub => {
        if (sub.submission_type_id === defaulterType?.id &&
            sub.status === 'completed' &&
            defaulterStudentIds.includes(sub.student_id)) {
          defaulterStudentsWithWork.add(sub.student_id);
        }
      });

      const statistics = {
        overallSubmission: Math.round((studentsWithSubmissions.size / totalStudents) * 100),
        submissionMarked: Math.round((studentsWithBothCompleted / totalStudents) * 100),
        defaulterWorkSubmitted: defaulterStudents > 0 
          ? Math.round((defaulterStudentsWithWork.size / defaulterStudents) * 100) 
          : 0,
        totalStudents,
        defaulterCount: defaulterStudents
      };

      return res.json({
        success: true,
        statistics
      });
    } catch (err) {
      console.error("Error fetching dashboard statistics:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Get subject-wise submission statistics
router.get("/subject-statistics", authenticateUser, authorizeRoles("faculty", "class_teacher", "hod"),
  async (req, res) => {
    try {
      const faculty_id = req.user.id;

      // Get subjects from faculty_subjects table
      const { data: fSubjects, error: fsError } = await supabase
        .from("faculty_subjects")
        .select(`
          subject_id,
          batch_id,
          class_id,
          subjects (
            id,
            name,
            subject_code,
            type,
            class_id
          )
        `)
        .eq("faculty_id", faculty_id);

      if (fsError) throw fsError;
      const facultySubjects = fSubjects || [];

      // Also get elective subjects from department_offered_subjects
      const { data: offeredSubjects, error: offeredError } = await supabase
        .from('department_offered_subjects')
        .select(`
          subject_id,
          faculty_ids,
          year,
          department_id,
          subjects (
            id,
            name,
            subject_code,
            type
          )
        `)
        .contains('faculty_ids', [faculty_id]);

      if (offeredError) throw offeredError;

      // Collect elective subject IDs and their student mappings
      const electiveSubjectMap = new Map(); // subject_id -> Set of student_ids

      // Add subjects from department_offered_subjects
      for (const offered of (offeredSubjects || [])) {
        if (offered.subjects && offered.subject_id) {
          if (!electiveSubjectMap.has(offered.subject_id)) {
            electiveSubjectMap.set(offered.subject_id, new Set());
          }
          
          // Get students for this year and department
          const { data: yearStudents, error: yearStudentsError } = await supabase
            .from('students')
            .select(`
              id,
              class_id,
              classes!inner (
                year,
                department_id
              )
            `)
            .eq('classes.year', offered.year)
            .eq('classes.department_id', offered.department_id);

          if (!yearStudentsError && yearStudents) {
            yearStudents.forEach(student => {
              electiveSubjectMap.get(offered.subject_id).add(student.id);
            });
          }
        }
      }

      // Also get elective subjects where this faculty is assigned via student selections
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
        .or(`mdm_faculty_id.eq.${faculty_id},oe_faculty_id.eq.${faculty_id},pe_faculty_id.eq.${faculty_id}`);

      if (electiveError) throw electiveError;

      // Add student selections to the map
      (electiveSelections || []).forEach(selection => {
        if (selection.mdm_faculty_id === faculty_id && selection.mdm_id) {
          if (!electiveSubjectMap.has(selection.mdm_id)) {
            electiveSubjectMap.set(selection.mdm_id, new Set());
          }
          electiveSubjectMap.get(selection.mdm_id).add(selection.student_id);
        }
        if (selection.oe_faculty_id === faculty_id && selection.oe_id) {
          if (!electiveSubjectMap.has(selection.oe_id)) {
            electiveSubjectMap.set(selection.oe_id, new Set());
          }
          electiveSubjectMap.get(selection.oe_id).add(selection.student_id);
        }
        if (selection.pe_faculty_id === faculty_id && selection.pe_id) {
          if (!electiveSubjectMap.has(selection.pe_id)) {
            electiveSubjectMap.set(selection.pe_id, new Set());
          }
          electiveSubjectMap.get(selection.pe_id).add(selection.student_id);
        }
      });

      // Fetch elective subject details
      const electiveSubjectIds = Array.from(electiveSubjectMap.keys());
      let electiveSubjects = [];
      if (electiveSubjectIds.length > 0) {
        const { data: eSubjects, error: eSubjectsError } = await supabase
          .from('subjects')
          .select('id, name, subject_code, type')
          .in('id', electiveSubjectIds);

        if (eSubjectsError) throw eSubjectsError;
        electiveSubjects = eSubjects || [];
      }

      // Get statistics for each subject
      const subjectStats = await Promise.all(
        facultySubjects.map(async (fs) => {
          try {
            const subject = fs.subjects;
            if (!subject) return null;

            // Get total students for this subject
            let studentQuery = supabase
              .from("students")
              .select("id, defaulter", { count: 'exact' })
              .eq("class_id", fs.class_id);

            if (fs.batch_id) {
              studentQuery = studentQuery.eq("batch_id", fs.batch_id);
            }

            const { data: students, count: totalStudents, error: studentsError } = await studentQuery;
            if (studentsError) return null;

            const studentIds = (students || []).map(s => s.id);
            const defaulterCount = (students || []).filter(s => s.defaulter).length;

            // Get submission statistics
            let submissions = [];
            if (studentIds.length > 0) {
              const { data: submissionsData, error: submissionsError } = await supabase
                .from("student_submissions")
                .select("student_id, submission_type_id, status")
                .eq("subject_id", subject.id)
                .in("student_id", studentIds);

              if (submissionsError) return null;
              submissions = submissionsData || [];
            }

            // Get submission types
            const { data: submissionTypes, error: typesError } = await supabase
              .from("submission_types")
              .select("*");

            if (typesError) return null;

            // Calculate statistics per submission type
            const typeStats = {};
            (submissionTypes || []).forEach(type => {
              const typeSubmissions = submissions.filter(s => s.submission_type_id === type.id);
              const completed = typeSubmissions.filter(s => s.status === 'completed').length;
              const pending = typeSubmissions.filter(s => s.status === 'pending').length;
              
              typeStats[type.name] = {
                total: totalStudents || 0,
                completed,
                pending,
                notStarted: (totalStudents || 0) - completed - pending
              };
            });

            return {
              id: subject.id,
              name: subject.name,
              code: subject.subject_code,
              type: subject.type,
              totalStudents: totalStudents || 0,
              defaulterCount,
              submissionStats: typeStats
            };
          } catch (error) {
            console.error('Error processing subject stats:', error);
            return null;
          }
        })
      );

      // Process elective subjects
      const electiveStats = await Promise.all(
        electiveSubjects.map(async (subject) => {
          try {
            const studentIds = Array.from(electiveSubjectMap.get(subject.id) || []);
            const totalStudents = studentIds.length;

            if (totalStudents === 0) return null;

            // Get student details to count defaulters
            const { data: students, error: studentsError } = await supabase
              .from("students")
              .select("id, defaulter")
              .in("id", studentIds);

            if (studentsError) return null;

            const defaulterCount = (students || []).filter(s => s.defaulter).length;

            // Get submission statistics
            const { data: submissionsData, error: submissionsError } = await supabase
              .from("student_submissions")
              .select("student_id, submission_type_id, status")
              .eq("subject_id", subject.id)
              .in("student_id", studentIds);

            if (submissionsError) return null;
            const submissions = submissionsData || [];

            // Get submission types
            const { data: submissionTypes, error: typesError } = await supabase
              .from("submission_types")
              .select("*");

            if (typesError) return null;

            // Calculate statistics per submission type
            const typeStats = {};
            (submissionTypes || []).forEach(type => {
              const typeSubmissions = submissions.filter(s => s.submission_type_id === type.id);
              const completed = typeSubmissions.filter(s => s.status === 'completed').length;
              const pending = typeSubmissions.filter(s => s.status === 'pending').length;
              
              typeStats[type.name] = {
                total: totalStudents,
                completed,
                pending,
                notStarted: totalStudents - completed - pending
              };
            });

            return {
              id: subject.id,
              name: subject.name,
              code: subject.subject_code,
              type: subject.type,
              totalStudents,
              defaulterCount,
              submissionStats: typeStats
            };
          } catch (error) {
            console.error('Error processing elective subject stats:', error);
            return null;
          }
        })
      );

      const validStats = [...subjectStats, ...electiveStats].filter(s => s !== null);

      return res.json({
        success: true,
        subjects: validStats
      });
    } catch (err) {
      console.error("Error fetching subject statistics:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

export default router;