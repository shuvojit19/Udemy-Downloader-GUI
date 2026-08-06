const Settings = require("./settings");
const $ = window.$ || require("jquery");

function run() {
	// 1. Mutex Guard: Check for active downloads
	let hasActiveDownload = false;
	const $downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");
	
	$downloads.each((_index, element) => {
		const $item = $(element);
		const isDownloading = $item.data("isDownloading") === true || $item.data("isPreparing") === true ||
			($item.find(".download-status").is(":visible") && $item.find(".pause.button").is(":visible") && !$item.find(".pause.button").hasClass("disabled"));
		
		if (isDownloading) {
			hasActiveDownload = true;
		}
	});

	if (hasActiveDownload) {
		alert("Cannot realign sequences while downloads are active. Please pause or stop all downloads first.");
		return;
	}

	// 2. Read and Sort
	let courses = Settings.downloadedCourses || [];
	if (!courses.length) {
		alert("No downloaded courses found to realign.");
		return;
	}

	// Sort ascending by original sequenceNumber
	courses.sort((a, b) => Number(a.sequenceNumber || 0) - Number(b.sequenceNumber || 0));

	// 3. Re-index from 1 to N
	let history = Settings.downloadHistory || [];
	let updatedCount = 0;

	courses.forEach((course, index) => {
		const newSeq = index + 1;
		const oldSeq = Number(course.sequenceNumber);
		
		if (oldSeq !== newSeq) {
			course.sequenceNumber = newSeq;
			
			// 4. Update downloadHistory to match
			const histItem = history.find(h => Number(h.id) === Number(course.id));
			if (histItem) {
				histItem.sequenceNumber = newSeq;
			}
			updatedCount++;
		}
	});

	if (updatedCount === 0) {
		alert("All sequences are already perfectly aligned! No changes needed.");
		return;
	}

	// 5. Save Settings
	Settings.downloadedCourses = courses;
	Settings.downloadHistory = history;

	alert(`Successfully realigned sequences! ${updatedCount} courses updated.\nThe application will now reload to apply the changes.`);
	
	// Reload UI to reflect new sequences naturally without hacking DOM duplication
	window.location.reload();
}

module.exports = { run };
