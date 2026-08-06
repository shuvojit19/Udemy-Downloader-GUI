const fs = require("fs");
const { Settings, utils, ui } = require("../../helpers");
const sanitize = require("sanitize-filename");

class VerificationEngine {
    /**
     * Verifies if all files for a course exist and have a valid size.
     * Incorporates Mutex locking to prevent verifying an actively downloading course,
     * and DRM guards to prevent false "Missing" reports for encrypted lectures.
     * 
     * @param {jQuery} $course - The course element representing the DOM node
     * @param {Object} callbacks - Functions to decouple UI logic: { onProgress, onComplete, onError }
     */
    static async verifyCourseDownloads($course, callbacks) {
        const courseId = String($course.attr("course-id") || "").trim();
        const courseName = $course.find(".coursename").text();
        const seqNum = $course.find('input[name="sequence-number"]').val() || $course.data("sequenceNumber") || "N/A";

        if (!courseId) return;

        // --- Mutex Guard ---
        // Prevent verifying a course while it's currently writing to disk.
        if ($course.data("isDownloading") === true) {
            if (callbacks && callbacks.onError) {
                callbacks.onError("Cannot verify a course while it is actively downloading. Please wait for the download to finish or pause it.", seqNum);
            }
            return;
        }

        if (callbacks && callbacks.onStart) callbacks.onStart();

        let courseData = $course.data("courseData");
        try {
            if (!courseData) {
                if (callbacks && callbacks.onError) {
                    callbacks.onError("Failed to fetch course details for verification.", seqNum);
                }
                return;
            }

            const sanitizedCourseName = sanitize(courseData.name.trim());
            const downloadDirectory = Settings.downloadDirectory();
            const courseDir = `${downloadDirectory}/${sanitizedCourseName}`;

            let totalItemsChecked = 0;
            const missingItems = [];

            courseData.chapters.forEach((chapter, chapterIndex) => {
                const countLectures = chapter.lectures.length;
                const sanitizedChapterName = sanitize(chapter.name.trim());
                const seqChapterName = utils.getSequenceName(
                    chapterIndex + 1,
                    courseData.chapters.length,
                    sanitizedChapterName,
                    ". ",
                    courseDir
                ).name;

                chapter.lectures.forEach((lecture, lectureIndex) => {
                    const sanitizedLectureName = sanitize(lecture.name.trim());
                    const lectureType = (lecture.type || "").toLowerCase();

                    // --- DRM Guard ---
                    // If the lecture is encrypted with DRM, we cannot download it as a regular .mp4.
                    // To prevent it from showing up as "Missing" permanently, we skip its file check.
                    if (lecture.isEncrypted || (lecture.src && String(lecture.src).includes("encrypted-files"))) {
                        // We count it as checked (intact) so the progress bar is accurate, but we skip fs.existsSync
                        totalItemsChecked++;
                    } else {
                        // Regular unencrypted file verification
                        if (lectureType === "article" || lectureType === "url") {
                            totalItemsChecked++;
                            const wfDir = `${downloadDirectory}/${sanitizedCourseName}/${seqChapterName}`;
                            const htmlFile = utils.getSequenceName(lectureIndex + 1, countLectures, sanitizedLectureName + ".html", ". ", wfDir).fullPath;
                            if (!fs.existsSync(htmlFile) || fs.statSync(htmlFile).size === 0) {
                                missingItems.push({ type: "html", path: htmlFile });
                            }
                        } else {
                            totalItemsChecked++;
                            const seqName = utils.getSequenceName(
                                lectureIndex + 1,
                                countLectures,
                                sanitizedLectureName + (lectureType === "file" ? ".pdf" : ".mp4"),
                                ". ",
                                `${downloadDirectory}/${sanitizedCourseName}/${seqChapterName}`
                            );

                            if (!fs.existsSync(seqName.fullPath) || fs.statSync(seqName.fullPath).size === 0) {
                                missingItems.push({ type: "lecture", path: seqName.fullPath });
                            }
                        }
                    }

                    // Attachments check
                    if (lecture.attachments && Array.isArray(lecture.attachments)) {
                        lecture.attachments.forEach((att, attIndex) => {
                            if (!att || !att.name) return;
                            totalItemsChecked++;
                            const attachmentName = (att.name || "attachment").trim();
                            let fileExtension = (att.src || "").split("/").pop().split("?").shift().split(".").pop() || "";
                            fileExtension = att.name.split(".").pop() === fileExtension ? "" : (fileExtension ? "." + fileExtension : "");

                            const attSeqName = utils.getSequenceName(
                                lectureIndex + 1,
                                countLectures,
                                sanitize(attachmentName) + fileExtension,
                                `.${attIndex + 1} `,
                                `${downloadDirectory}/${sanitizedCourseName}/${seqChapterName}`
                            );

                            if (!fs.existsSync(attSeqName.fullPath) || fs.statSync(attSeqName.fullPath).size === 0) {
                                missingItems.push({ type: "attachment", path: attSeqName.fullPath });
                            }
                        });
                    }
                });
            });

            const isComplete = missingItems.length === 0;
            const intactCount = Math.max(0, totalItemsChecked - missingItems.length);

            if (callbacks && callbacks.onComplete) {
                callbacks.onComplete({
                    totalItemsChecked,
                    missingItems,
                    isComplete,
                    intactCount,
                    courseName,
                    seqNum
                });
            }

        } catch (error) {
            if (callbacks && callbacks.onError) {
                callbacks.onError(error, seqNum);
            }
        }
    }
}

module.exports = VerificationEngine;
