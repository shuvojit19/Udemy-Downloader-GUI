"use strict";

process.noDeprecation = true;

// PHASE 1: Removed `remote` import — all remote.dialog, remote.BrowserWindow,
// and remote.session usage is now handled via IPC handlers in main.js
const { shell, ipcRenderer } = require("electron");
const axios = require("axios");
const fs = require("fs");

const dialogs = require("dialogs")({});

const sanitize = require("sanitize-filename");
const vtt2srt = require("node-vtt-to-srt");
const Downloader = require("mt-files-downloader");
const https = require("https");
const cookie = require("cookie");

const { Settings, ui, utils } = require("./helpers");
const { default: UdemyService } = require("./core/services");
const Semaphore = require("./helpers/semaphore");
const VerificationEngine = require("./core/services/VerificationEngine");

const m3u8DownloadLimit = new Semaphore(20);

const PAGE_SIZE = 25;
const MSG_DRM_PROTECTED = translate("Contains DRM protection and cannot be downloaded");
const HTTP_TIMEOUT = 600000; // 600 segundos (10 min)

const loggers = [];
let repoAccount = "heliomarpm";
let udemyService;

// Attach SequenceMigrator to window so index.html UI can call it
window.realignSequences = require('./helpers/SequenceMigrator');

ipcRenderer.on("saveDownloads", () => saveDownloads(true));

// external browser
// $(document).on('click', 'a[href^="http"]', (event) => {
$(document).on("click", ".how-get-token", (event) => {
	event.preventDefault();
	shell.openExternal(event.target.href);
});

$(document).ajaxError(function (_event, _request) {
	$(".dimmer").removeClass("active");
});

$(".ui.dropdown").dropdown();

$(".ui.login #business").on("change", function () {
	if ($(this).is(":checked")) {
		ui.$subdomainField.val(Settings.subDomain);
		ui.toggleSubdomainField(true);
	} else {
		ui.$subdomainField.val(null);
		ui.toggleSubdomainField(false);
	}
});

$(".courses-sidebar").on("click", function () {
	ui.navSidebar(this, "courses");
});

$(".downloads-sidebar").on("click", async function () {
	ui.navSidebar(this, "downloads");
	renderDownloads();
});

$(".settings-sidebar").on("click", function () {
	ui.navSidebar(this, "settings");
	loadSettings();
});

$(".about-sidebar").on("click", function () {
	ui.navSidebar(this, "about");
});

$(".logger-sidebar").on("click", function () {
	ui.navSidebar(this, "logger");
	clearBagdeLoggers();
});

$(".logout-sidebar").on("click", function () {
	dialogs.confirm(translate("Confirm Log Out?"), function (ok) {
		if (ok) {
			ui.busyLogout(true);
			saveDownloads(false);
			Settings.accessToken = null;
			ui.resetToLogin();
		}
	});
});

$(".ui.dashboard .content").on("click", ".load-more.button", (e) => loadMore(e.currentTarget));

$(".ui.dashboard .content").on("click", ".dismiss-download", function () {
	const courseId = $(this).parents(".course.item").attr("course-id");
	removeCurseDownloads(courseId);
});

$(".ui.dashboard .content").on("click", ".open-in-browser", function () {
	const link = `https://${Settings.subDomain}.udemy.com${$(this).parents(".course.item").attr("course-url")}`;
	shell.openExternal(link);
});

$(".ui.dashboard .content").on("click", ".open-dir", function () {
	const pathDownloaded = $(this).parents(".course.item").find('input[name="path-downloaded"]').val();
	shell.openPath(pathDownloaded);
});

$(".ui.dashboard .content").on("click", ".check-updates", () => checkUpdate("heliomarpm"));

$(".ui.dashboard .content").on("click", ".check-updates-original", () => checkUpdate("FaisalUmair"));

$(".ui.dashboard .content").on("click", ".old-version-mac", () => {
	shell.openExternal("https://github.com/FaisalUmair/udemy-downloader-gui/releases/download/v1.8.2/Udeler-1.8.2-mac.dmg");
});

$(".ui.dashboard .content").on("click", ".old-version-linux", () => {
	shell.openExternal("https://github.com/FaisalUmair/udemy-downloader-gui/releases/download/v1.8.2/Udeler-1.8.2-linux-x86_x64.AppImage");
});

$(".ui.dashboard .content").on("click", ".download-success, .course-encrypted", function () {
	$(this).hide();
	$(this).parents(".course").find(".download-status").show();
});

$(".ui.dashboard .content").on("click", ".save_m3u.button", function (e) {
	e.stopImmediatePropagation();
	saveM3u($(this).parents(".course"));
});
$(".ui.dashboard .content").on("click", ".download.button, .download-error", function (e) {
	e.stopImmediatePropagation();
	prepareDownloading($(this).parents(".course"));
});

$(".ui.dashboard .content").on("click", ".verify.button", function (e) {
	e.stopImmediatePropagation();
	const $course = $(this).parents(".course");
	$course.data("verifiedStatus", "");
	$course.data("verifiedDetails", "");
	updateCourseStatusTags($course, {}); // Clear visual tags immediately
	verifyCourseDownloads($course);
});



$(".ui.dashboard .content").on("click", ".download-missing.button, .redownload.button", function (e) {
	e.stopImmediatePropagation();
	downloadMissingFiles($(this).parents(".course"));
});

$(".ui.dashboard .content").on("click", ".tag-verified.label", function (e) {
	if ($(this).text().includes("Missing")) {
		e.stopImmediatePropagation();
		downloadMissingFiles($(this).parents(".course"));
	}
});

$(".ui.dashboard .content").on("click", "#clear_logger", clearLogArea);

$(".ui.dashboard .content").on("click", "#save_logger", saveLogFile);

$(".ui.dashboard .content .courses.section .search.form").on("submit", function (e) {
	e.preventDefault();
	const keyword = $(e.target).find("input").val();
	search(keyword);
});

$(".download-update.button").on("click", () => {
	shell.openExternal(`https://github.com/${repoAccount}/udemy-downloader-gui/releases/latest`);
});

$(".content .ui.about").on("click", 'a[href^="http"]', function (e) {
	e.preventDefault();
	shell.openExternal(this.href);
});

$(".ui.settings .form").on("submit", (e) => {
	e.preventDefault();
	saveSettings(e.target);
});

const $settingsForm = $(".ui.settings .form");

$settingsForm.find('input[name="enabledownloadstartend"]').on("change", function () {
	$settingsForm.find('input[name="downloadstart"], input[name="downloadend"]').prop("readonly", !this.checked);
});

function loadSettings() {
	$settingsForm.find('input[name="check-new-version"]').prop("checked", Boolean(Settings.download.checkNewVersion));
	$settingsForm.find('input[name="auto-start-download"]').prop("checked", Boolean(Settings.download.autoStartDownload));
	$settingsForm
		.find('input[name="continue-downloading-encrypted"]')
		.prop("checked", Boolean(Settings.download.continueDonwloadingEncrypted));

	$settingsForm.find('input[name="enabledownloadstartend"]').prop("checked", Boolean(Settings.download.enableDownloadStartEnd));
	$settingsForm
		.find('input[name="downloadstart"], input[name="downloadend"]')
		.prop("readonly", !Boolean(Settings.download.enableDownloadStartEnd));

	$settingsForm.find('input:radio[name="downloadType"]').filter(`[value="${Settings.download.type}"]`).prop("checked", true);
	$settingsForm.find('input[name="skipsubtitles"]').prop("checked", Boolean(Settings.download.skipSubtitles));
	$settingsForm.find('input[name="autoretry"]').prop("checked", Boolean(Settings.download.autoRetry));
	$settingsForm.find('input[name="seq-zero-left"]').prop("checked", Boolean(Settings.download.seqZeroLeft));

	$settingsForm.find('input[name="downloadpath"]').val(Settings.downloadDirectory());
	$settingsForm.find('input[name="downloadstart"]').val(Settings.download.downloadStart);
	$settingsForm.find('input[name="downloadend"]').val(Settings.download.downloadEnd);
	$settingsForm.find('input[name="maxconcurrentdownloads"]').val(Settings.download.maxConcurrentDownloads ?? 4);

	const videoQuality = Settings.download.videoQuality;
	$settingsForm.find('input[name="videoquality"]').val(videoQuality);
	$settingsForm
		.find('input[name="videoquality"]')
		.parent(".dropdown")
		.find(".default.text")
		.html(translate(videoQuality || "Auto"));

	const language = Settings.language;
	$settingsForm.find('input[name="language"]').val(language || "");
	$settingsForm
		.find('input[name="language"]')
		.parent(".dropdown")
		.find(".default.text")
		.html(language || "English");

	const defaultSubtitle = Settings.download.defaultSubtitle;
	$settingsForm.find('input[name="defaultSubtitle"]').val(defaultSubtitle || "");
	$settingsForm
		.find('input[name="defaultSubtitle"]')
		.parent(".dropdown")
		.find(".defaultSubtitle.text")
		.html(defaultSubtitle || "");

	const externalUrlFormat = Settings.download.externalUrlFormat || "txt";
	$settingsForm.find('input[name="externalUrlFormat"]').val(externalUrlFormat);
	$settingsForm
		.find('input[name="externalUrlFormat"]')
		.parent(".dropdown")
		.find(".default.text")
		.html(
			externalUrlFormat === "txt" ? ".txt (" + translate("Default") + ")" :
			externalUrlFormat === "url" ? ".url" :
			translate("Both") + " (.txt & .url)"
		);

	$settingsForm.find('input[name="downloadExternalUrls"]').prop("checked", Boolean(Settings.download.downloadExternalUrls));
}

function saveSettings(formElement) {
	const findInput = (inputName, attr = "") => $(formElement).find(`input[name="${inputName}"]${attr}`);

	const def = Settings.DownloadDefaultOptions;

	const checkNewVersion = findInput("check-new-version")[0].checked ?? def.checkNewVersion;
	const defaultSubtitle = findInput("defaultSubtitle").val() ?? def.defaultSubtitle;
	const downloadPath = findInput("downloadpath").val() ?? def.path;
	const autoStartDownload = findInput("auto-start-download")[0].checked ?? def.autoStartDownload;
	const continueDonwloadingEncrypted = findInput("continue-downloading-encrypted")[0].checked ?? def.continueDonwloadingEncrypted;
	const enableDownloadStartEnd = findInput("enabledownloadstartend")[0].checked ?? def.enableDownloadStartEnd;
	const downloadStart = parseInt(findInput("downloadstart").val() ?? def.downloadStart);
	const downloadEnd = parseInt(findInput("downloadend").val() ?? def.downloadEnd);
	const maxConcurrentDownloads = parseInt(findInput("maxconcurrentdownloads").val() ?? def.maxConcurrentDownloads, 10) || 4;
	const videoQuality = findInput("videoquality").val() ?? def.videoQuality;
	const downloadType = findInput("downloadType", ":checked").val() ?? def.type;
	const skipSubtitles = findInput("skipsubtitles")[0].checked ?? def.skipSubtitles;
	const seqZeroLeft = findInput("seq-zero-left")[0].checked ?? def.seqZeroLeft;
	const autoRetry = findInput("autoretry")[0].checked ?? def.autoRetry;
	const downloadExternalUrls = findInput("downloadExternalUrls")[0].checked ?? def.downloadExternalUrls;
	const externalUrlFormat = findInput("externalUrlFormat").val() || def.externalUrlFormat || "txt";
	const language = findInput("language").val() ?? undefined;

	Settings.download = {
		checkNewVersion,
		defaultSubtitle,
		path: downloadPath,
		autoStartDownload,
		continueDonwloadingEncrypted,
		enableDownloadStartEnd,
		downloadStart,
		downloadEnd,
		videoQuality,
		type: Number(downloadType),
		skipSubtitles,
		seqZeroLeft,
		autoRetry,
		downloadExternalUrls,
		externalUrlFormat,
		maxConcurrentDownloads,
	};

	Settings.language = language;

	processDownloadQueue();
	showAlert(translate("Settings Saved"));
}

// PHASE 1: selectDownloadPath() — Replaced remote.dialog.showOpenDialogSync()
// with async IPC invoke to main process handler "show-open-dialog"
async function selectDownloadPath() {
	const paths = await ipcRenderer.invoke("show-open-dialog", {
		properties: ["openDirectory"],
	});

	if (paths && paths[0]) {
		fs.access(paths[0], fs.constants.R_OK && fs.constants.W_OK, function (err) {
			if (err) {
				showAlert(translate("Cannot select this folder"));
			} else {
				$settingsForm.find('input[name="downloadpath"]').val(paths[0]);
			}
		});
	}
}

async function checkUpdate(account, silent = false) {
	ui.busyCheckUpdate(true);

	try {
		const response = await fetch(`https://api.github.com/repos/${account}/udemy-downloader-gui/releases/latest`);

		if (!response.ok) {
			throw new Error(`Failed to check for updates: ${response.status}`);
		}

		const data = await response.json();
		if (data.tag_name != `v${appVersion}`) {
			repoAccount = account;
			$(".ui.update-available.modal").modal("show");
		} else if (!silent) {
			showAlert(translate("No updates available"));
		}
	} catch (error) {
		console.error("Failed to check for updates", error);
		if (!silent) {
			showAlert(translate("Failed to check for updates"), translate("Check for updates"));
		}
		appendLog("Failed to check for updates", error);
	} finally {
		ui.busyCheckUpdate(false);
	}
}

async function checkLogin(alertExpired = true) {
	if (Settings.accessToken) {
		try {
			ui.busyLogin(true);

			udemyService = new UdemyService(Settings.subDomain, HTTP_TIMEOUT);
			const userContext = await udemyService.fetchProfile(Settings.accessToken, 30000);

			if (!userContext.header.isLoggedIn) {
				if (alertExpired) {
					showAlert(Settings.accessToken, translate("Token expired"));
				}
				ui.resetToLogin();
				return;
			}
			ui.busyLogin(false);
			ui.showDashboard();

			Settings.subscriber = utils.toBoolean(userContext.header.user.enableLabsInPersonalPlan) || utils.toBoolean(userContext.header.user.consumer_subscription_active);
			fetchCourses(Settings.subscriber).then(() => {
				console.log("fetchCourses done");
			});

			if (Settings.download.checkNewVersion) {
				checkUpdate("heliomarpm", true);
			}
		} catch (error) {
			console.error("Failed to fetch user profile", error);
			if (!process.env.DEBUG_MODE) Settings.accessToken = null;

			ui.resetToLogin();
			showAlert(error.message, error.name || "Error");
		} finally {
			console.log("access-token", Settings.accessToken);
		}
	}
}

// PHASE 1: loginWithUdemy() — Replaced remote.BrowserWindow + remote.session
// with a single IPC call. The main process now handles the entire login flow:
// creating the popup, intercepting the auth token, and returning it here.
async function loginWithUdemy() {
	const $formLogin = $(".ui.login .form");

	if ($formLogin.find('input[name="business"]').is(":checked")) {
		if (!ui.$subdomainField.val()) {
			showAlert("Type Business Name");
			return;
		}
	} else {
		ui.$subdomainField.val(null);
	}

	const subdomain = ui.$subdomainField.val() || "www";
	Settings.subDomain = subdomain;

	// IPC bridge: main process opens the login window, intercepts the token,
	// and returns { token, subdomain } or null if the user cancelled.
	const result = await ipcRenderer.invoke("open-login-window", { subdomain });
	if (result) {
		Settings.accessToken = result.token;
		Settings.subDomain = result.subdomain;
		checkLogin();
	}
}

function loginWithAccessToken() {
	const $formLogin = $(".ui.login .form");

	if ($formLogin.find('input[name="business"]').is(":checked")) {
		if (!ui.$subdomainField.val()) {
			showAlert("Type Business Name");
			return;
		}
	} else {
		ui.$subdomainField.val("www");
	}

	dialogs.prompt("Access Token", (access_token) => {
		if (access_token) {
			const submain = ui.$subdomainField.val();
			Settings.accessToken = access_token;
			Settings.subDomain = submain.trim().length == 0 ? "www" : submain.trim();

			checkLogin();
		}
	});
}

function getNextPermanentSequenceNumber() {
	let maxSeq = 0;
	$(".ui.downloads.section .ui.course.item").each((_i, el) => {
		const s = parseInt($(el).find('input[name="sequence-number"]').val() || $(el).data("sequenceNumber"), 10);
		if (!isNaN(s) && s > maxSeq) maxSeq = s;
	});
	if (Array.isArray(Settings.downloadedCourses)) {
		Settings.downloadedCourses.forEach((c) => {
			const s = parseInt(c.sequenceNumber, 10);
			if (!isNaN(s) && s > maxSeq) maxSeq = s;
		});
	}
	if (Array.isArray(Settings.downloadHistory)) {
		Settings.downloadHistory.forEach((h) => {
			const s = parseInt(h.sequenceNumber, 10);
			if (!isNaN(s) && s > maxSeq) maxSeq = s;
		});
	}
	return maxSeq + 1;
}

function assignSequenceNumberToCourse($course) {
	if (!$course || !$course.length) return 0;
	let currentSeq = Number($course.find('input[name="sequence-number"]').val() || $course.data("sequenceNumber") || 0);

	const courseId = Number($course.attr("course-id"));
	if (!currentSeq && courseId) {
		if (Array.isArray(Settings.downloadHistory)) {
			const histItem = Settings.downloadHistory.find((x) => Number(x.id) === courseId);
			if (histItem && histItem.sequenceNumber) currentSeq = Number(histItem.sequenceNumber);
		}
		if (!currentSeq && Array.isArray(Settings.downloadedCourses)) {
			const savedItem = Settings.downloadedCourses.find((x) => Number(x.id) === courseId);
			if (savedItem && savedItem.sequenceNumber) currentSeq = Number(savedItem.sequenceNumber);
		}
	}

	if (!currentSeq) {
		currentSeq = getNextPermanentSequenceNumber();
	}

	$course.find('input[name="sequence-number"]').val(currentSeq);
	$course.data("sequenceNumber", currentSeq);

	if (courseId && Settings.downloadHistory) {
		const histItem = Settings.downloadHistory.find((x) => Number(x.id) === courseId);
		if (histItem) histItem.sequenceNumber = currentSeq;
	}
	if (courseId && Settings.downloadedCourses) {
		const savedItem = Settings.downloadedCourses.find((x) => Number(x.id) === courseId);
		if (savedItem) savedItem.sequenceNumber = currentSeq;
	}

	updateCourseStatusTags($course);
	return currentSeq;
}

function ensureSequenceNumbersAssigned() {
	const $downloadCourses = $(".ui.downloads.section .ui.courses.items .ui.course.item");
	if (!$downloadCourses.length) return;

	$downloadCourses.each((_index, el) => {
		assignSequenceNumberToCourse($(el));
	});
}

function createCourseElement(courseCache, downloadSection = false) {
	courseCache.completed = courseCache.completed || false;
	courseCache.infoDownloaded = "";
	courseCache.encryptedVideos = 0;
	courseCache.pathDownloaded = "";
	courseCache.name = courseCache.name || courseCache.title;
	courseCache.sequenceNumber = downloadSection ? (Number(courseCache.sequenceNumber) || 0) : 0;

	const downloadedCourse = Settings.downloadedCourses ? Settings.downloadedCourses.find((x) => Number(x.id) === Number(courseCache.id)) : null;
	if (downloadedCourse && downloadedCourse.sequenceNumber && downloadSection && !courseCache.sequenceNumber) {
		courseCache.sequenceNumber = Number(downloadedCourse.sequenceNumber) || 0;
	}

	const history = Settings.downloadHistory.find((x) => Number(x.id) === Number(courseCache.id));
	if (history) {
		courseCache.infoDownloaded = translate(history.completed ? "Download finished on" : "Download started since") + " " + history.date;
		courseCache.completed = history.completed ? true : courseCache.completed;
		courseCache.encryptedVideos = Math.max(courseCache.encryptedVideos, history.encryptedVideos);
		courseCache.selectedSubtitle = history.selectedSubtitle ?? "";
		courseCache.pathDownloaded = history.pathDownloaded ?? "";
		if (history.sequenceNumber && downloadSection && !courseCache.sequenceNumber) {
			courseCache.sequenceNumber = Number(history.sequenceNumber) || 0;
		}
		courseCache.verifiedStatus = courseCache.verifiedStatus || history.verifiedStatus || "";
		courseCache.verifiedDetails = courseCache.verifiedDetails || history.verifiedDetails || "";
		courseCache.drmStatus = courseCache.drmStatus || history.drmStatus || "";
		courseCache.drmDetails = courseCache.drmDetails || history.drmDetails || "";
		courseCache.historyDate = history.date || "";
	}

	// Se o caminho não existir, obtenha o caminho de configurações de download para o título do curso
	if (!fs.existsSync(courseCache.pathDownloaded)) courseCache.pathDownloaded = Settings.downloadDirectory(sanitize(courseCache.name));

	const tagDismiss = `<a class="ui basic dismiss-download">&nbsp;&nbsp;&nbsp;${translate("Dismiss")}</a>`;

	const instructorsList = (courseCache.visible_instructors || courseCache.instructors || [])
		.map((i) => i.title || i.display_name || i.name)
		.filter(Boolean)
		.join(", ");
	const instructorSubtitle = instructorsList ? `<div class="extra instructor-name" style="color: #666; font-size: 0.9em; margin-top: 3px; margin-bottom: 5px;"><i class="user icon"></i> ${instructorsList}</div>` : "";

	const $course = $(`
        <div class="ui course item" course-id="${courseCache.id}" course-url="${courseCache.url}" course-completed="${courseCache.completed}" style="padding-top: 35px !important; padding-bottom: 25px;">
            <input type="hidden" name="encryptedvideos" value="${courseCache.encryptedVideos}">
            <input type="hidden" name="selectedSubtitle" value="${courseCache.selectedSubtitle}">
            <input type="hidden" name="path-downloaded" value="${courseCache.pathDownloaded}">
            <input type="hidden" name="sequence-number" value="${courseCache.sequenceNumber}">

            <div class="ui tiny label download-quality grey"></div>
            <div class="ui tiny black label download-speed">
                <span class="value">0</span>
                <span class="download-unit"> KB/s</span>
            </div>

            <div class="ui tiny image wrapper">
                <div class="ui red left corner label icon-encrypted">
                    <i class="lock icon"></i>
                </div>
                <img src="${courseCache.image ?? courseCache.image_240x135}" class="course-image border-radius" />
                ${downloadSection ? tagDismiss : ""}
                <div class="tooltip">${courseCache.encryptedVideos == 0 ? "" : MSG_DRM_PROTECTED}</div>
            </div>

            <div class="content">
                <span class="coursename">${courseCache.name}</span>
                ${instructorSubtitle}
                <div class="ui tiny icon green download-success message" style="display: none;">
                    <i class="check icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${translate("Download Finished")}</h4>
                        </div>
                        <p>${translate("Click to dismiss")}</p>
                    </div>
                </div>
                <div class="ui tiny icon red download-error message" style="display: none;">
                    <i class="bug icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${translate("Download Failed")}</h4>
                        </div>
                        <p>${translate("Click to retry")}</p>
                    </div>
                </div>
                <div class="ui tiny icon purple course-encrypted message" style="display: none;">
                    <i class="lock icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${MSG_DRM_PROTECTED}</h4>
                        </div>
                        <p>${translate("Click to dismiss")}</p>
                    </div>
                </div>

                <div class="extra download-status">
                    ${ui.actionCardTemplate}
                </div>
                <!-- <div style="margin-top:15px"><span class="lecture-name"></span></div> -->
            </div>
        </div>`);

	$course.data("sequenceNumber", courseCache.sequenceNumber);
	$course.data("historyDate", history ? history.date : "");
	$course.data("completed", courseCache.completed);

	if (courseCache.completed) {
		resetCourse($course, $course.find(".download-success"));
	} else if (courseCache.encryptedVideos > 0) {
		resetCourse($course, $course.find(".course-encrypted"));
	}

	if (downloadSection && !courseCache.completed) {
		$course.find(".individual.progress").progress("set percent", courseCache.individualProgress).css("display", "block");
		$course.find(".combined.progress").progress("set percent", courseCache.combinedProgress).css("display", "block");
		$course.find(".status-text-label").html(courseCache.progressStatus);
	}

	if (courseCache.verifiedStatus) $course.data("verifiedStatus", courseCache.verifiedStatus);
	if (courseCache.verifiedDetails) $course.data("verifiedDetails", courseCache.verifiedDetails);
	if (courseCache.drmStatus) $course.data("drmStatus", courseCache.drmStatus);
	if (courseCache.drmDetails) $course.data("drmDetails", courseCache.drmDetails);
	if (courseCache.historyDate) $course.data("historyDate", courseCache.historyDate);

	updateCourseStatusTags($course);

	if (Number(courseCache.encryptedVideos) === 0) {
		$course.find(".icon-encrypted").hide();
		$course.find(".ui.tiny.image .tooltip").hide();
		$course.find(".ui.tiny.image").removeClass("wrapper");
	} else {
		$course.find(".icon-encrypted").show();
		$course.find(".ui.tiny.image .tooltip").show();
		$course.find(".ui.tiny.image").addClass("wrapper");
	}

	if (!fs.existsSync(courseCache.pathDownloaded)) {
		$course.find(".open-dir.button").hide();
	}

	return $course;
}

function updateCourseStatusTags($course, customData = {}) {
	if (!$course || !$course.length) return;

	let $tagsContainer = $course.find(".course-status-tags");
	if (!$tagsContainer.length) {
		$tagsContainer = $('<div class="course-status-tags" style="margin-top: 8px; margin-bottom: 4px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; justify-content: flex-start; clear: both; text-align: left;"></div>');
		const $content = $course.find(".content");
		if ($content.find(".download-status").length) {
			$content.find(".download-status").prepend($tagsContainer);
		} else {
			$content.append($tagsContainer);
		}
	} else {
		$tagsContainer.css({ display: "flex", "flex-direction": "column", gap: "4px", "align-items": "flex-start", "justify-content": "flex-start", clear: "both", "text-align": "left" });
	}

	if (customData.verifiedStatus !== undefined) $course.data("verifiedStatus", customData.verifiedStatus);
	if (customData.verifiedDetails !== undefined) $course.data("verifiedDetails", customData.verifiedDetails);
	if (customData.drmStatus !== undefined) $course.data("drmStatus", customData.drmStatus);
	if (customData.drmDetails !== undefined) $course.data("drmDetails", customData.drmDetails);
	if (customData.historyDate !== undefined) $course.data("historyDate", customData.historyDate);

	const isCompleted = $course.attr("course-completed") === "true" || $course.data("completed") === true;
	const historyDate = $course.data("historyDate") || "";
	const verifiedStatus = $course.data("verifiedStatus") || "";
	const verifiedDetails = $course.data("verifiedDetails") || "";
	const drmStatus = $course.data("drmStatus") || "";
	const drmDetails = $course.data("drmDetails") || "";
	const encryptedVideos = Number($course.find('input[name="encryptedvideos"]').val() || 0);
	const seqNum = Number($course.find('input[name="sequence-number"]').val() || $course.data("sequenceNumber") || 0);

	let baseTags = "";
	if (seqNum > 0) {
		baseTags += `<span class="ui blue tiny label tag-sequence" style="margin: 0;"><i class="hashtag icon"></i> Seq #${seqNum}</span>`;
	}
	if (isCompleted) {
		const dateStr = historyDate ? ` (${historyDate})` : "";
		baseTags += `<span class="ui green tiny label tag-finished" style="margin: 0;"><i class="check circle icon"></i> ${translate("Download Finished")}${dateStr}</span>`;
	}

	let verificationTag = "";
	if (verifiedStatus === "complete") {
		verificationTag = `<span class="ui purple tiny label tag-verified" style="margin: 0;"><i class="shield check icon"></i> Verified (${verifiedDetails || "100% Intact"})</span>`;
	} else if (verifiedStatus === "missing") {
		verificationTag = `<span class="ui red tiny label tag-verified" style="margin: 0;"><i class="exclamation triangle icon"></i> ${verifiedDetails || "Missing Files"}</span>`;
	}

	let drmTag = "";
	if (drmStatus === "protected" || (encryptedVideos > 0 && !drmStatus)) {
		drmTag = `<span class="ui orange tiny label tag-drm" style="margin: 0;"><i class="lock icon"></i> DRM Protected ${drmDetails ? `(${drmDetails})` : ""}</span>`;
	} else if (drmStatus === "free") {
		drmTag = `<span class="ui teal tiny label tag-drm" style="margin: 0;"><i class="unlock icon"></i> DRM Free (100% Downloadable)</span>`;
	}

	let rowsHtml = "";
	if (baseTags) {
		rowsHtml += `<div class="tags-row base-row" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start;">${baseTags}</div>`;
	}
	if (verificationTag) {
		rowsHtml += `<div class="tags-row verification-row" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start;">${verificationTag}</div>`;
	}
	if (drmTag) {
		rowsHtml += `<div class="tags-row drm-row" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: flex-start;">${drmTag}</div>`;
	}

	$tagsContainer.html(rowsHtml);
	$course.find(".info-downloaded").hide();
}

function getActiveDownloadCount(excludeCourseId = null) {
	let activeCount = 0;
	const $downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");
	const excludeStr = excludeCourseId ? String(excludeCourseId).trim() : null;

	$downloads.each((_index, element) => {
		const $item = $(element);
		const itemId = String($item.attr("course-id") || "").trim();
		if (excludeStr && itemId === excludeStr) {
			return;
		}

		const isCompleted = $item.attr("course-completed") === "true" || $item.find(".download-success").is(":visible");
		const isError = $item.find(".download-error").is(":visible") || $item.find(".course-encrypted").is(":visible");
		const isUserPaused = $item.data("isPaused") === true;

		const isDownloading = ($item.data("isDownloading") === true || $item.data("isPreparing") === true) ||
			($item.find(".download-status").is(":visible") && $item.find(".pause.button").is(":visible") && !$item.find(".pause.button").hasClass("disabled"));

		if (isDownloading && !isCompleted && !isError && !isUserPaused) {
			activeCount++;
		}
	});
	return activeCount;
}

function sortDownloads() {
	const $downloadsContainer = $(".ui.downloads.section .ui.courses.items");
	const $items = $downloadsContainer.children(".ui.course.item").get();

	if (!$items || !$items.length) return;

	$items.sort((a, b) => {
		const getCategoryPriority = (el) => {
			const $item = $(el);
			const isCompleted = $item.attr("course-completed") === "true" || $item.find(".download-success").is(":visible");
			const isError = $item.find(".download-error").is(":visible") || $item.find(".course-encrypted").is(":visible");
			const isUserPaused = $item.data("isPaused") === true;
			const isQueued = $item.data("isQueued") === true;
			const isPreparing = $item.data("isPreparing") === true;
			const isDownloading = $item.data("isDownloading") === true || ($item.find(".download-status").is(":visible") && $item.find(".pause.button").is(":visible") && !$item.find(".pause.button").hasClass("disabled"));

			// Priority 5: Finished / Completed downloads (LAST)
			if (isCompleted) {
				return 5;
			}
			// Priority 4: Download errors
			if (isError) {
				return 4;
			}
			// Priority 3: Getting information for downloads
			if (isPreparing) {
				return 3;
			}
			// Priority 2: User paused downloads & queued
			if (isUserPaused || isQueued) {
				return 2;
			}
			// Priority 1: Active ongoing downloads (TOP)
			if (isDownloading) {
				return 1;
			}
			return 1;
		};

		const pA = getCategoryPriority(a);
		const pB = getCategoryPriority(b);

		if (pA !== pB) {
			return pA - pB;
		}

		const seqA = Number($(a).find('input[name="sequence-number"]').val() || $(a).data("sequenceNumber") || 0);
		const seqB = Number($(b).find('input[name="sequence-number"]').val() || $(b).data("sequenceNumber") || 0);
		return seqA - seqB;
	});

	$.each($items, (_index, element) => {
		$downloadsContainer.append(element);
	});
}

function processDownloadQueue() {
	const maxConcurrent = Settings.download.maxConcurrentDownloads || 4;
	const $downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");

	let activeCount = 0;
	const pendingItems = [];

	$downloads.each((_index, element) => {
		const $item = $(element);
		const isCompleted = $item.attr("course-completed") === "true" || $item.find(".download-success").is(":visible");
		const isError = $item.find(".download-error").is(":visible") || $item.find(".course-encrypted").is(":visible");
		const isUserPaused = $item.data("isPaused") === true;

		// Active if data flag is true OR if pause button is active & visible in DOM
		const isDownloading = ($item.data("isDownloading") === true || $item.data("isPreparing") === true) ||
			($item.find(".download-status").is(":visible") && $item.find(".pause.button").is(":visible") && !$item.find(".pause.button").hasClass("disabled"));

		if (isDownloading && !isCompleted && !isError && !isUserPaused) {
			activeCount++;
		} else if (!isCompleted && !isError && !isUserPaused) {
			$item.data("isQueued", true);
			pendingItems.push($item);
		}
	});

	// Sort pending queued items by sequenceNumber ascending (FIFO order: lowest sequence number first)
	pendingItems.sort((a, b) => {
		const seqA = Number($(a).find('input[name="sequence-number"]').val() || $(a).data("sequenceNumber") || 0);
		const seqB = Number($(b).find('input[name="sequence-number"]').val() || $(b).data("sequenceNumber") || 0);
		return seqA - seqB;
	});

	// Update Queue Labels (Queue #1, Queue #2...) for all pending items
	pendingItems.forEach((element, index) => {
		const $item = $(element);
		const queueRank = index + 1;
		$item.find(".status-text-label").html(`${translate("Queued")} #${queueRank}`);
		$item.find(".download-status").show();
		$item.find(".action.buttons .download.button").addClass("disabled");
		$item.find(".action.buttons .pause.button").addClass("disabled");
		$item.find(".action.buttons .resume.button").removeClass("disabled");
	});

	console.log(`[processDownloadQueue] Active downloads: ${activeCount}/${maxConcurrent}, Pending queued: ${pendingItems.length}`);

	while (activeCount < maxConcurrent && pendingItems.length > 0) {
		const $nextItem = pendingItems.shift();
		activeCount++;
		$nextItem.data("isQueued", false);
		$nextItem.data("isPaused", false);
		$nextItem.data("isDownloading", true);

		$nextItem.find(".action.buttons .pause.button").removeClass("disabled");
		$nextItem.find(".action.buttons .resume.button").addClass("disabled");
		$nextItem.find(".status-text-label").html(translate("Downloading..."));
		$nextItem.find(".download-status").show();

		const startFn = $nextItem.data("startDownloadFn");
		if (typeof startFn === "function") {
			startFn();
		} else {
			const selectedSubtitle = $nextItem.find('input[name="selectedSubtitle"]').val();
			prepareDownloading($nextItem, selectedSubtitle);
		}
	}

	sortDownloads();
}

function setCourseCompletedStatus($course, isCompleted) {
	const courseId = Number($course.attr("course-id"));
	$course.attr("course-completed", isCompleted ? "true" : "");
	$course.data("completed", isCompleted);
	if (isCompleted) {
		$course.find(".download-success").show();
	} else {
		$course.find(".download-success").hide();
	}

	if (courseId) {
		const historyItem = Settings.downloadHistory.find((x) => Number(x.id) === courseId);
		if (historyItem) historyItem.completed = isCompleted;
		const savedItem = Settings.downloadedCourses.find((x) => Number(x.id) === courseId);
		if (savedItem) savedItem.completed = isCompleted;
	}
}

function resetCourse($course, $elMessage, autoRetry, courseData, subtitle) {
	$course.data("isDownloading", false);
	$course.data("isPreparing", false);
	$course.data("isQueued", false);

	$course.find(".download-success").hide();
	$course.find(".download-error").hide();

	if ($elMessage.hasClass("download-success")) {
		setCourseCompletedStatus($course, true);
	} else {
		setCourseCompletedStatus($course, false);

		if ($elMessage.hasClass("download-error") && autoRetry && courseData) {
			if (courseData.errorCount++ < 5) {
				$course.length = 1;
				startDownload($course, courseData, subtitle);
				return;
			}
		}
	}

	$course.find(".download-quality").hide();
	$course.find(".download-speed").hide().find(".value").html(0);
	$course.find(".download-status").hide().html(ui.actionCardTemplate);
	// $course.css("padding", "14px 0px");
	$elMessage.css("display", "flex");

	if (Number($course.find("input[name='encryptedvideos']").val()) > 0) {
		$course.find(".icon-encrypted").show();
		$course.find(".ui.tiny.image .tooltip").show();
		$course.find(".ui.tiny.image").addClass("wrapper");
	}

	processDownloadQueue();
	sortDownloads();
	saveDownloads(false);
}

function renderCourses(response, isResearch = false) {
	const $coursesSection = $(".ui.dashboard .ui.courses.section");
	const $coursesItems = $coursesSection.find(".ui.courses.items").empty();

	$coursesSection.find(".disposable").remove();

	if (response.results.length) {
		// response.results.forEach(course => {
		//     $coursesItems.append(htmlCourseCard(course));
		// });
		const courseElements = response.results.map((course) => createCourseElement(course));
		$coursesItems.append(courseElements);

		if (response.next) {
            const dataUrl = Array.isArray(response.next) ? response.next : [response.next];
			// added loadMore Button
			$coursesSection.append(
				`<button class="ui basic blue fluid load-more button disposable" data-url=${JSON.stringify(dataUrl)}>
                    ${translate("Load More")}
                </button>`
			);
		}
	} else {
		let msg = "";
		if (!isResearch) {
			msg = getMsgChangeSearchMode();
			appendLog(translate("No Courses Found"), msg);
		}

		$coursesItems.append(
			`<div class="ui yellow message disposable">
                ${translate("No Courses Found")} <br/>
                ${translate("Remember, you will only be able to see the courses you are enrolled in")}
                ${msg}
            </div>`
		);
	}
}

async function renderDownloads() {
	const $downloadsSection = $(".ui.downloads.section .ui.courses.items");

	// Deduplicate any existing items in DOM
	const seenIds = new Set();
	$downloadsSection.find(".ui.course.item").each(function () {
		const id = String($(this).attr("course-id") || "").trim();
		if (!id || seenIds.has(id)) {
			$(this).remove();
		} else {
			seenIds.add(id);
		}
	});

	const rawDownloadedCourses = Settings.downloadedCourses || [];
	const downloadedCourses = [];
	const settingSeenIds = new Set();
	rawDownloadedCourses.forEach((c) => {
		const idStr = String(c.id || "").trim();
		if (idStr && !settingSeenIds.has(idStr)) {
			settingSeenIds.add(idStr);
			downloadedCourses.push(c);
		}
	});

	if (!downloadedCourses.length) {
		isDownloadsLoaded = true;
	} else {
		ui.busyLoadDownloads(true);

		function addCourseToDOM(course) {
			return new Promise((resolve, _reject) => {
				const idStr = String(course.id || "").trim();
				if ($downloadsSection.find(`[course-id="${idStr}"]`).length) {
					resolve();
					return;
				}

				const $courseItem = createCourseElement(course, true);
				$downloadsSection.append($courseItem);

				if (!course.completed) {
					if (Settings.download.autoStartDownload) {
						prepareDownloading($courseItem, course.selectedSubtitle);
					} else {
						$courseItem.data("isQueued", true);
						$courseItem.find(".download-status .label").html(course.progressStatus || translate("Queued (Auto-Paused)"));
						$courseItem.find(".download-status").show();
						$courseItem.find(".action.buttons .download.button").addClass("disabled");
						$courseItem.find(".action.buttons .pause.button").addClass("disabled");
						$courseItem.find(".action.buttons .resume.button").removeClass("disabled");
					}
				}

				resolve();
			});
		}

		const promises = downloadedCourses.map((course) => addCourseToDOM(course));

		Promise.all(promises)
			.then(() => {
				isDownloadsLoaded = true;
				ui.busyLoadDownloads(false);
				processDownloadQueue();
				sortDownloads();
			})
			.catch((e) => {
				console.trace("Error adding courses:", e);
				ui.busyLoadDownloads(false);
			});
	}
}

async function fetchCourseContent(courseId, courseName, courseUrl) {
	try {
		// ui.busyBuildCourseData(true);

		const response = await udemyService.fetchCourseContent(courseId, "all");
		if (!response) {
			// ui.busyBuildCourseData(false);
			showAlert(`Id: ${courseId}`, translate("Course not found"));
			return null;
		}
		console.log(`fetchCourseContent (${courseId})`, response);

		const downloadType = Number(Settings.download.type);
		const downloadLectures = downloadType === Settings.DownloadType.Both || downloadType === Settings.DownloadType.OnlyLectures;
		const downloadAttachments = downloadType === Settings.DownloadType.Both || downloadType === Settings.DownloadType.OnlyAttachments;
		const downloadExternalURLs = downloadType === Settings.DownloadType.Both || downloadType === Settings.DownloadType.OnlyExternalURLs;

		const courseData = {
			id: courseId,
			name: courseName,
			chapters: [],
			totalLectures: 0,
			encryptedVideos: 0,
			errorCount: 0,
			availableSubs: [],
		};

		let chapterData = null;
		response.results.forEach((item) => {
			const type = item._class.toLowerCase();
			if (type == "chapter") {
				if (chapterData) {
					courseData.chapters.push(chapterData);
				}
				chapterData = { id: item.id, name: item.title.trim(), lectures: [] };
			} else if (type == "quiz" || type == "practice") {
				const srcUrl = `${courseUrl}t/${item._class}/${item.id}`;

				if (downloadExternalURLs) {
					chapterData.lectures.push({
						type: "url",
						name: item.title,
						src: `<script type="text/javascript">window.location = "${srcUrl}";</script>`,
						quality: "Attachment",
						externalUrl: srcUrl,
					});
					courseData.totalLectures++;
				}
			} else {
				const lecture = { id: item.id, type, name: item.title, src: "", quality: Settings.download.videoQuality, isEncrypted: false };
				const { asset, supplementary_assets = [] } = item;
				const assetType = asset?.asset_type ? asset.asset_type.toLowerCase() : "";

				if (!asset || !assetType) {
					lecture.type = "url";
					lecture.quality = "NotFound";
					lecture.src = `<script type="text/javascript">window.location = "${courseUrl}/${item._class}/${item.id}";</script>`;
					appendLog("Asset missing", `Course: ${courseId}|${courseName}`, `Lecture: ${item.id}|${item.title}`);
				} else if (assetType == "article") {
					lecture.type = "article";
					lecture.quality = asset.asset_type;
					lecture.src = asset.data?.body ?? asset.body ?? "";
				} else if (assetType == "file" || assetType == "e-book") {
					lecture.type = "file";
					lecture.quality = asset.asset_type;
					lecture.src = asset.download_urls?.[asset.asset_type]?.[0]?.file || "";
				} else if (assetType == "presentation") {
					lecture.type = "file";
					lecture.quality = asset.asset_type;
					lecture.src = asset.url_set?.[asset.asset_type]?.[0]?.file || "";
				} else if (assetType.startsWith("video")) {
					const streams = asset.streams;

					if (!streams || !streams.minQuality) {
						//WARN: File not uploaded
						lecture.type = "url";
						lecture.quality = "NotFound";
						lecture.src = `<script type="text/javascript">window.location = "${courseUrl}/${item._class}/${item.id}";</script>`;
						appendLog("File not uploaded", `Course: ${courseId}|${courseName}`, `Lecture: ${item.id}|${item.title}`);
					} else {

						switch ( (lecture.quality || "").toLowerCase()) {
                            case "":
							case "auto":
							case "highest":
								lecture.quality = streams.maxQuality;
								break;
							case "lowest":
								lecture.quality = streams.minQuality;
								break;
							default:
                                lecture.quality = utils.isNumber(lecture.quality) ? lecture.quality : lecture.quality.slice(0, -1);
						}

						if (lecture.quality && !streams.sources[lecture.quality]) {
							if (utils.isNumber(lecture.quality) && streams.maxQuality != "auto") {
								const source = utils.getClosestValue(streams.sources, lecture.quality);
								lecture.quality = source?.key || streams.maxQuality;
							} else {
								lecture.quality = streams.maxQuality;
							}
						}

						let selectedSource = streams.sources ? streams.sources[lecture.quality] : null;
						if (!selectedSource || !selectedSource.url) {
							const availableKeys = Object.keys(streams.sources || {});
							if (availableKeys.length > 0) {
								selectedSource = streams.sources[streams.maxQuality] || streams.sources[availableKeys[0]];
							}
						}

						lecture.src = selectedSource?.url || "";
						lecture.type = selectedSource?.type || "video/mp4";
						if (streams.isEncrypted) {
							lecture.isEncrypted = true;
							courseData.encryptedVideos++;
						}
					}
				} else {
					appendLog("Unknown Asset Type ", `type: ${assetType}`, `Course: ${courseId}|${courseName}`);
				}

				if (!Settings.download.skipSubtitles && asset?.captions && asset.captions.length > 0) {
					lecture.subtitles = {};

					asset.captions.forEach((caption) => {
						caption.video_label in courseData.availableSubs
							? (courseData.availableSubs[caption.video_label] = courseData.availableSubs[caption.video_label] + 1)
							: (courseData.availableSubs[caption.video_label] = 1);

						lecture.subtitles[caption.video_label] = caption.url;
					});
				}

				if ((downloadAttachments || downloadExternalURLs) && supplementary_assets && supplementary_assets.length > 0) {
					const attachments = (lecture.attachments = []);

					supplementary_assets.forEach((attachment) => {
						const isFile = !!attachment.download_urls;
						const type = isFile ? "file" : "url";
						
						if (isFile && !downloadAttachments) return;
						if (!isFile && !downloadExternalURLs) return;

						const src = isFile
							? attachment.download_urls[attachment.asset_type][0].file
							: `<script type="text/javascript">window.location = "${attachment.external_url}";</script>`;

						attachments.push({ type, name: attachment.title, src, quality: "Attachment", externalUrl: attachment.external_url });
					});
				}

				chapterData.lectures.push(lecture);
				courseData.totalLectures++;
			}
		});

		if (chapterData) {
			courseData.chapters.push(chapterData);
		}

		// ui.busyBuildingCourseData(false);
		return courseData;
	} catch (error) {
		handleApiError(error, "EBUILDING_COURSE_DATA", courseName, true);
	}
}

async function fetchCourses(isSubscriber) {
	ui.busyLoadCourses(true);

	udemyService
		.fetchCourses(PAGE_SIZE, isSubscriber)
		.then((resp) => {
			renderCourses(resp);
			if (Settings.downloadedCourses) {
				renderDownloads();
			}
		})
		.catch((e) => {
			handleApiError(e, "EFETCHING_COURSES");
		})
		.finally(() => {
			ui.busyLoadCourses(false);
		});
}

function loadMore(loadMoreButton) {
	const $button = $(loadMoreButton);
	const $courses = $button.prev(".courses.items");
	const url = [...$button.data("url")];

	ui.busyLoadCourses(true);
	udemyService
		.fetchLoadMore(url[0])
		.then((resp) => {
			$courses.append(...resp.results.map((course) => createCourseElement(course, false)));
			if (!resp.next) {
                if (url.length > 1) {
                    $button.data("url", [url[1]]);
                } else {
                    $button.remove();
                }
			} else {
                if (url.length > 1) {
                    $button.data("url", [resp.next, url[1]]);
                }else {
                    $button.data("url", [resp.next]);
                }
            }
		})
		.catch((e) => {
			const statusCode = (e.response?.status || 0).toString() + (e.code ? ` :${e.code}` : "");
			appendLog(`ELOADING_MORE: (${statusCode})`, e);
		})
		.finally(() => {
			ui.busyLoadCourses(false);
		});
}

async function search(keyword) {
	ui.busyLoadCourses(true);

	try {
		const courses = await udemyService.fetchSearchCourses(keyword, PAGE_SIZE, Settings.subscriber);
		renderCourses(courses, !!keyword);
	} catch (error) {
		handleApiError(error, "ESEARCHING_COURSES", null, false);
	} finally {
		ui.busyLoadCourses(false);
	}
}

function getMsgChangeSearchMode() {
	const msg = Settings.subscriber
		? translate("This account has been identified with a subscription plan")
		: translate("This account was identified without a subscription plan");

	const button = `
    <div class="ui fluid buttons">
        <button class='ui primary button change-search-mode' onclick='toggleSubscriber()'>${translate("Change search mode")}</button>
    </div>`;

	return `<p>${msg}<br/>${translate("If it's wrong, change the search mode and try again")}${button}</p>`;
}

/**
 * Toggles the subscriber setting and clears the search field.
 */
function toggleSubscriber() {
	Settings.subscriber = !Settings.subscriber;
	search("");
}

function addDownloadHistory(
	courseId,
	courseName,
	completed = false,
	encryptedVideos = 0,
	selectedSubtitle = "",
	pathDownloaded = "",
	sequenceNumber = 0,
	verifiedStatus = "",
	verifiedDetails = "",
	drmStatus = "",
	drmDetails = ""
) {
	const items = Settings.downloadHistory;
	const item = items.find((x) => Number(x.id) === Number(courseId));

	if (item) {
		if (completed !== Boolean(item.completed)) {
			item.completed = completed;
			item.date = new Date(Date.now()).toLocaleDateString();
		}
		item.encryptedVideos = encryptedVideos;
		item.selectedSubtitle = selectedSubtitle;
		item.pathDownloaded = pathDownloaded;
		if (sequenceNumber && !item.sequenceNumber) {
			item.sequenceNumber = sequenceNumber;
		}
		if (verifiedStatus !== undefined) item.verifiedStatus = verifiedStatus;
		if (verifiedDetails !== undefined) item.verifiedDetails = verifiedDetails;
		if (drmStatus !== undefined) item.drmStatus = drmStatus;
		if (drmDetails !== undefined) item.drmDetails = drmDetails;
	} else {
		items.push({
			id: courseId,
			name: courseName,
			completed,
			date: new Date(Date.now()).toLocaleDateString(),
			encryptedVideos,
			selectedSubtitle,
			pathDownloaded,
			sequenceNumber,
			verifiedStatus: verifiedStatus || "",
			verifiedDetails: verifiedDetails || "",
			drmStatus: drmStatus || "",
			drmDetails: drmDetails || "",
		});
	}

	Settings.downloadHistory = items;
}

function getDownloadHistory(courseId) {
	return Settings.downloadHistory.find((x) => x.id === courseId) || undefined;
}

let isDownloadsLoaded = false;

function saveDownloads(shouldQuitApp = false) {
	if (shouldQuitApp) {
		ui.busySavingHistory(true);
	}

	try {
		function getProgress($progress) {
			const dataPercent = $progress.attr("data-percent");
			return parseInt(dataPercent, 10) || 0;
		}

		const downloadedCourses = [];
		ensureSequenceNumbersAssigned();
		const downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");

		if (!isDownloadsLoaded && !downloads.length) {
			console.log("[saveDownloads] Skipped saving empty list before renderDownloads complete.");
			return;
		}

		const seenCourseIds = new Set();

		downloads.each((_index, element) => {
			const $el = $(element);
			const courseId = String($el.attr("course-id") || "").trim();
			if (!courseId) return;

			if (seenCourseIds.has(courseId)) {
				$el.remove();
				return;
			}
			seenCourseIds.add(courseId);

			const hasProgress = $el.find(".progress.active").length > 0;
			const individualProgress = hasProgress ? getProgress($el.find(".download-status .individual.progress")) : 0;
			const combinedProgress = hasProgress ? getProgress($el.find(".download-status .combined.progress")) : 0;
			const isCompleted = $el.attr("course-completed") === "true";
			const sequenceNumber = Number($el.find('input[name="sequence-number"]').val() || $el.data("sequenceNumber") || 0);

			const courseData = {
				id: courseId,
				url: $el.attr("course-url") || "",
				name: $el.find(".coursename").text() || "",
				title: $el.find(".coursename").text() || "",
				image: $el.find(".image img").attr("src") || "",
				individualProgress: Math.min(100, individualProgress),
				combinedProgress: Math.min(100, combinedProgress),
				completed: isCompleted,
				progressStatus: $el.find(".status-text-label").text() || $el.find(".download-status .label").text() || "",
				encryptedVideos: Number($el.find('input[name="encryptedvideos"]').val() || 0),
				selectedSubtitle: $el.find('input[name="selectedSubtitle"]').val() || "",
				pathDownloaded: $el.find('input[name="path-downloaded"]').val() || "",
				sequenceNumber: sequenceNumber,
				verifiedStatus: $el.data("verifiedStatus") || "",
				verifiedDetails: $el.data("verifiedDetails") || "",
				drmStatus: $el.data("drmStatus") || "",
				drmDetails: $el.data("drmDetails") || "",
			};

			downloadedCourses.push(courseData);
			addDownloadHistory(
				courseData.id,
				courseData.name,
				courseData.completed,
				courseData.encryptedVideos,
				courseData.selectedSubtitle,
				courseData.pathDownloaded,
				courseData.sequenceNumber,
				courseData.verifiedStatus,
				courseData.verifiedDetails,
				courseData.drmStatus,
				courseData.drmDetails
			);
		});

		if (downloads.length > 0 || isDownloadsLoaded) {
			Settings.downloadedCourses = downloadedCourses;
			console.log(`[saveDownloads] Saved ${downloadedCourses.length} courses to settings.`);
		}
	} catch (error) {
		console.error("[saveDownloads] Error persisting downloads:", error);
	} finally {
		if (shouldQuitApp) {
			ipcRenderer.send("quitApp");
		} else {
			ui.busySavingHistory(false);
		}
	}
}

function removeCurseDownloads(courseId) {
	const $downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");

	$downloads.each((_index, element) => {
		const $el = $(element);
		if ($el.attr("course-id") == courseId) {
			$el.remove();
		}
	});
	saveDownloads(false);
}

async function saveM3u($course) {
	ui.prepareDownloading($course);

	const courseId = $course.attr("course-id");
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;

	console.clear();

	let courseData = null;
	try {
		courseData = await fetchCourseContent(courseId, courseName, courseUrl);
		if (!courseData) {
			// ui.showProgress($course, false);
			return;
		}

        console.log(courseData);
        ipcRenderer.invoke("show-save-dialog", {
			title: "Save M3U",
			defaultPath: `${courseName}.m3u`,
			filters: [{ name: "M3U File (*.m3u)", fileExtension: ["m3u"] }],
		})
		.then((result) => {
			if (!result.canceled) {
				let filePath = result.filePath;
				if (!filePath.endsWith(".m3u")) filePath += ".m3u";

				let content = "#EXTM3U";
                let index = 0;
				courseData.chapters.forEach((chapter) => {
                    chapter.lectures.forEach((lecture, lec_index) => {
                        index++;
                        content += `\n#EXTINF:-1,${lec_index+1}. ${lecture.name}\n${lecture.src}`;

                        if (lecture.attachments && lecture.attachments.length > 0)
                          lecture.attachments.forEach((attachment, attach_index) => {
                            content += `\n#EXTINF:-1,${lec_index+1}.${attach_index+1} ${attachment.name}\n${attachment.src}`;
                          })
                    })
				});

				fs.writeFile(filePath, content, (error) => {
					if (error) {
						appendLog("saveM3u_Error", error);
						return;
					}
					console.log("File successfully create!");
				});
			}
		});

	} catch (error) {
		handleApiError(error, "ESAVE_M3U", null, false);
		ui.busyOff();
		$course.find(".prepare-downloading").hide();
	} finally {
        ui.showProgress($course, false);
    }
}

async function renderDownloads() {
	const $downloadsSection = $(".ui.downloads.section .ui.courses.items");
	if ($downloadsSection.find(".ui.course.item").length) {
		return;
	}

	const downloadedCourses = Settings.downloadedCourses || [];
	if (!downloadedCourses.length) {
		isDownloadsLoaded = true;
	} else {
		ui.busyLoadDownloads(true);

		function addCourseToDOM(course) {
			return new Promise((resolve, _reject) => {
				const $courseItem = createCourseElement(course, true);
				$downloadsSection.append($courseItem);

				if (!course.completed) {
					if (Settings.download.autoStartDownload) {
						prepareDownloading($courseItem, course.selectedSubtitle);
					} else {
						$courseItem.data("isQueued", true);
						$courseItem.find(".download-status .label").html(course.progressStatus || translate("Queued (Auto-Paused)"));
						$courseItem.find(".download-status").show();
						$courseItem.find(".action.buttons .download.button").addClass("disabled");
						$courseItem.find(".action.buttons .pause.button").addClass("disabled");
						$courseItem.find(".action.buttons .resume.button").removeClass("disabled");
					}
				}

				resolve();
			});
		}

		const promises = downloadedCourses.map((course) => addCourseToDOM(course));

		Promise.all(promises)
			.then(() => {
				isDownloadsLoaded = true;
				ui.busyLoadDownloads(false);
				ensureSequenceNumbersAssigned();
				processDownloadQueue();
				sortDownloads();
				saveDownloads(false);
			})
			.catch((e) => {
				console.trace("Error adding courses:", e);
				ui.busyLoadDownloads(false);
			});
	}
}

async function prepareDownloading($course, subtitle) {
	if ($course.data("isActionLocked")) return;
	$course.data("isActionLocked", true);
	try {
		await _prepareDownloading($course, subtitle);
	} finally {
		$course.data("isActionLocked", false);
	}
}

async function _prepareDownloading($course, subtitle) {
	const courseId = $course.attr("course-id");
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;

	// Ensure the course item is IMMEDIATELY added to the Downloads tab DOM so searching another course will not lose it!
	const $downloads = $(".ui.downloads.section .ui.courses.items");
	const idStr = String(courseId || "").trim();
	let $downloadItem = $downloads.find(`[course-id="${idStr}"]`);

	if ($downloadItem.length > 1) {
		$downloadItem.slice(1).remove();
		$downloadItem = $downloadItem.eq(0);
	}

	if (!$downloadItem.length) {
		const history = Settings.downloadHistory.find((x) => Number(x.id) === Number(courseId));
		const courseObj = {
			id: courseId,
			url: $course.attr("course-url"),
			name: courseName,
			title: courseName,
			image: $course.find(".image img").attr("src"),
			completed: false,
			encryptedVideos: Number($course.find('input[name="encryptedvideos"]').val() || 0),
			selectedSubtitle: subtitle || "",
			pathDownloaded: $course.find('input[name="path-downloaded"]').val() || "",
			individualProgress: 0,
			combinedProgress: 0,
			progressStatus: translate("Fetching course details..."),
			sequenceNumber: Number($course.find('input[name="sequence-number"]').val() || $course.data("sequenceNumber") || 0),
			verifiedStatus: history ? history.verifiedStatus : "",
			verifiedDetails: history ? history.verifiedDetails : "",
			drmStatus: history ? history.drmStatus : "",
			drmDetails: history ? history.drmDetails : "",
		};
		$downloadItem = createCourseElement(courseObj, true);
		assignSequenceNumberToCourse($downloadItem);
		$downloads.append($downloadItem);
	}

	setCourseCompletedStatus($course, false);
	setCourseCompletedStatus($downloadItem, false);

	$course.data("isPreparing", true);
	$downloadItem.data("isPreparing", true);
	$downloadItem.data("isQueued", false);
	ui.prepareDownloading($course);
	ui.prepareDownloading($downloadItem);

	const skipSubtitles = Boolean(Settings.download.skipSubtitles);
	const defaultSubtitle = skipSubtitles ? null : (subtitle ?? Settings.download.defaultSubtitle);

	console.clear();

	let courseData = $downloadItem.data("courseData");
	try {
		// ALWAYS FETCH FRESH COURSE DETAILS IF NOT PRESENT OR IF URLS MAY BE EXPIRED (>30 mins old)
		if (!courseData || !courseData.fetchedAt || (Date.now() - courseData.fetchedAt > 1800000)) {
			const freshData = await fetchCourseContent(courseId, courseName, courseUrl);
			if (freshData) {
				freshData.fetchedAt = Date.now();
				courseData = freshData;
			}
			if (!courseData) {
				$course.data("isPreparing", false);
				$downloadItem.data("isPreparing", false);
				ui.showProgress($course, false);
				ui.showProgress($downloadItem, false);
				processDownloadQueue();
				return;
			}
			$downloadItem.data("courseData", courseData);
			$course.data("courseData", courseData);
		}

		if (courseData.encryptedVideos > 0 && !Settings.download.continueDonwloadingEncrypted) {
			$course.data("isPreparing", false);
			$downloadItem.data("isPreparing", false);
			resetCourse($course, $course.find(".course-encrypted"));
			resetCourse($downloadItem, $downloadItem.find(".course-encrypted"));
			processDownloadQueue();
			return;
		}

		const startDirectDownload = (selectedSub) => {
			$course.data("isPreparing", false);
			$downloadItem.data("isPreparing", false);
			startDownload($downloadItem, courseData, selectedSub || defaultSubtitle || "");
		};

		$downloadItem.data("startDownloadFn", () => startDirectDownload(defaultSubtitle));

		const otherActiveCount = getActiveDownloadCount(courseId);
		const maxConcurrent = Settings.download.maxConcurrentDownloads || 4;

		if (otherActiveCount >= maxConcurrent) {
			// Auto-pause and queue in Downloads section with all details pre-fetched!
			$course.data("isPreparing", false);
			$downloadItem.data("isPreparing", false);
			$downloadItem.data("isQueued", true);
			$downloadItem.data("isDownloading", false);

			ui.showProgress($course, false);
			ui.showProgress($downloadItem, false);

			$downloadItem.find(".download-status .label").html(translate("Queued (Auto-Paused)"));
			$downloadItem.find(".download-status").show();
			$course.find(".download-status .label").html(translate("Queued (Auto-Paused)"));
			$course.find(".download-status").show();

			$downloadItem.find(".action.buttons .download.button").addClass("disabled");
			$downloadItem.find(".action.buttons .pause.button").addClass("disabled");
			$downloadItem.find(".action.buttons .resume.button").removeClass("disabled");

			$course.find(".action.buttons .download.button").addClass("disabled");
			$course.find(".action.buttons .pause.button").addClass("disabled");
			$course.find(".action.buttons .resume.button").removeClass("disabled");

			console.log(`[prepareDownloading] Fetched details for course ${courseId}. Queued & Auto-paused (Active: ${otherActiveCount}/${maxConcurrent})`);
			sortDownloads();
			saveDownloads(false);
		} else {
			askForSubtitle(courseData.availableSubs, courseData.totalLectures, defaultSubtitle, (sub) => {
				startDirectDownload(sub);
			});
		}
	} catch (error) {
		$course.data("isPreparing", false);
		$downloadItem.data("isPreparing", false);
		const errorName = error.name === "EASK_FOR_SUBTITLE" ? error.name : "EPREPARE_DOWNLOADING";
		handleApiError(error, errorName, null, false);
		ui.busyOff();
		$course.find(".prepare-downloading").hide();
		$downloadItem.find(".prepare-downloading").hide();
		resetCourse($course, $course.find(".download-error"), Settings.download.autoRetry, courseData, subtitle);
		resetCourse($downloadItem, $downloadItem.find(".download-error"), Settings.download.autoRetry, courseData, subtitle);
		processDownloadQueue();
	}
}

async function verifyCourseDownloads($course) {
	if ($course.data("isActionLocked")) return;
	$course.data("isActionLocked", true);
	try {
		await _verifyCourseDownloads($course);
	} finally {
		$course.data("isActionLocked", false);
	}
}

async function _verifyCourseDownloads($course) {
	const courseId = String($course.attr("course-id") || "").trim();
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;
	const seqNum = $course.find('input[name="sequence-number"]').val() || $course.data("sequenceNumber") || "N/A";

	$course.find(".download-success").hide();
	$course.find(".download-error").hide();
	$course.find(".course-encrypted").hide();

	$course.find(".status-text-label").html(translate("Auditing DRM & verifying course files..."));
	$course.find(".download-status").show();
	ui.showProgress($course, true);

	let courseData = $course.data("courseData");
	try {
		if (!courseData) {
			courseData = await fetchCourseContent(courseId, courseName, courseUrl);
			if (courseData) {
				$course.data("courseData", courseData);
			}
		}

		let totalLectures = 0;
		let drmEncryptedCount = 0;
		let downloadableCount = 0;

		if (courseData && courseData.chapters && Array.isArray(courseData.chapters)) {
			courseData.chapters.forEach((chapter) => {
				if (chapter.lectures && Array.isArray(chapter.lectures)) {
					chapter.lectures.forEach((lecture) => {
						totalLectures++;
						if (lecture.isEncrypted || (lecture.src && String(lecture.src).includes("encrypted-files"))) {
							drmEncryptedCount++;
						} else {
							downloadableCount++;
						}
					});
				}
			});
			$course.find('input[name="encryptedvideos"]').val(drmEncryptedCount);
			ui.configureEncryptedIcon($course);
		}

		const canDownloadEverything = drmEncryptedCount === 0;

		await VerificationEngine.verifyCourseDownloads($course, {
			onStart: () => {},
			onComplete: ({ totalItemsChecked, missingItems, isComplete, intactCount, courseName, seqNum }) => {
				ui.showProgress($course, false);

				updateCourseStatusTags($course, {
					drmStatus: canDownloadEverything ? "free" : "protected",
					drmDetails: canDownloadEverything ? "100% Downloadable" : `${drmEncryptedCount}/${totalLectures} encrypted`,
					verifiedStatus: isComplete ? "complete" : "missing",
					verifiedDetails: isComplete ? `${totalItemsChecked} items intact` : `Missing ${missingItems.length} files`,
				});

				if (totalItemsChecked > 0) {
					const $combinedProgress = $course.find(".combined.progress");
					$combinedProgress.progress({
						total: totalItemsChecked,
						value: intactCount,
						text: {
							active: `${translate("Downloaded")} {value} ${translate("out of")} {total} ${translate("items")}`,
						},
					});
					$combinedProgress.progress("set percent", parseInt((intactCount / totalItemsChecked) * 100));
					$combinedProgress.show();
				}

				if (isComplete) {
					setCourseCompletedStatus($course, true);

					const message = `[Seq #${seqNum}] Course Audit & Verification: ${courseName}\n- DRM Status: ${canDownloadEverything ? "DRM Free (100% Downloadable)" : `${drmEncryptedCount}/${totalLectures} DRM Encrypted`}\n- File Integrity: Verified 100% Complete (${totalItemsChecked} items intact)`;
					dialogs.alert(message, function () {});
					appendLog(`Course Audit [Seq #${seqNum}]`, message);
				} else {
					setCourseCompletedStatus($course, false);



					const message = `[Seq #${seqNum}] Course Audit & Verification: ${courseName}\n- DRM Status: ${canDownloadEverything ? "DRM Free (100% Downloadable)" : `${drmEncryptedCount}/${totalLectures} DRM Encrypted`}\n- File Integrity: ${missingItems.length} missing file(s) out of ${totalItemsChecked}.\n\nWould you like to re-download missing files now?`;
					
					const missingFilesLogList = missingItems.map(item => `  - [${item.type.toUpperCase()}] ${item.path}`).join('\n');
					const logMessage = `[Seq #${seqNum}] Course Audit & Verification: ${courseName}\n- DRM Status: ${canDownloadEverything ? "DRM Free (100% Downloadable)" : `${drmEncryptedCount}/${totalLectures} DRM Encrypted`}\n- File Integrity: ${missingItems.length} missing file(s) out of ${totalItemsChecked}.\nMissing Files:\n${missingFilesLogList}`;
					
					appendLog(`Course Audit [Seq #${seqNum}]`, logMessage);

					dialogs.confirm(message, (ok) => {
						if (ok) {
							downloadMissingFiles($course);
						}
					});
				}

				updateCourseStatusTags($course);
				saveDownloads(false);
				$course.find(".download-status").show();
			},
			onError: (errorMsg, seqNum) => {
				ui.showProgress($course, false);

				if (typeof errorMsg === "string") {
					dialogs.alert(errorMsg);
				} else {
					appendLog("EAUDIT_COURSE", errorMsg);
				}

				$course.find(".download-status .status-text-label").html(translate("Audit & verification failed. Check logger."));
			},
		});
	} catch (err) {
		ui.showProgress($course, false);
		appendLog("EAUDIT_COURSE", err);
	}
}



async function downloadMissingFiles($course) {
	if ($course.data("isActionLocked")) return;
	$course.data("isActionLocked", true);
	try {
		await _downloadMissingFiles($course);
	} finally {
		$course.data("isActionLocked", false);
	}
}

async function _downloadMissingFiles($course) {
	const courseId = String($course.attr("course-id") || "").trim();
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;
	const seqNum = $course.find('input[name="sequence-number"]').val() || $course.data("sequenceNumber") || "N/A";

	if (!courseId) return;

	$course.find(".status-text-label").html(translate("Checking for missing files..."));
	$course.find(".download-status").show();
	ui.showProgress($course, true);

	try {
		let courseData = $course.data("courseData");
		if (!courseData || !courseData.fetchedAt || (Date.now() - courseData.fetchedAt > 1800000)) {
			$course.find(".status-text-label").html(translate("Fetching fresh download links..."));
			const freshData = await fetchCourseContent(courseId, courseName, courseUrl);
			if (freshData) {
				freshData.fetchedAt = Date.now();
				courseData = freshData;
			}
		}

		if (!courseData) {
			$course.find(".status-text-label").html(translate("Failed to fetch course details."));
			ui.showProgress($course, false);
			return;
		}
		$course.data("courseData", courseData);

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

				if (lectureType === "article" || lectureType === "url") {
					totalItemsChecked++;
					const wfDir = `${downloadDirectory}/${sanitizedCourseName}/${seqChapterName}`;
					const htmlFile = utils.getSequenceName(lectureIndex + 1, countLectures, sanitizedLectureName + ".html", ". ", wfDir).fullPath;
					if (!fs.existsSync(htmlFile) || fs.statSync(htmlFile).size === 0) {
						missingItems.push({ name: lecture.name, type: "html", path: htmlFile, isEncrypted: false });
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
						const isEncrypted = lecture.isEncrypted || (lecture.src && String(lecture.src).includes("encrypted-files"));
						missingItems.push({ name: lecture.name, type: "lecture", path: seqName.fullPath, isEncrypted, src: lecture.src });
					}
				}

				if (lecture.attachments && Array.isArray(lecture.attachments)) {
					lecture.attachments.forEach((att, attIndex) => {
						if (!att || !att.name) return;
						totalItemsChecked++;
						const attachmentName = (att.name || "attachment").trim();
						if (att.externalUrl || att.type === "url") {
							const attSeqName = utils.getSequenceName(
								lectureIndex + 1,
								countLectures,
								sanitize(attachmentName) + ".html",
								`.${attIndex + 1} `,
								`${downloadDirectory}/${sanitizedCourseName}/${seqChapterName}`
							);
							if (!fs.existsSync(attSeqName.fullPath) || fs.statSync(attSeqName.fullPath).size === 0) {
								missingItems.push({ name: attachmentName, type: "attachment", path: attSeqName.fullPath, isEncrypted: false, src: att.src });
							}
						} else {
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
								missingItems.push({ name: attachmentName, type: "attachment", path: attSeqName.fullPath, isEncrypted: false, src: att.src });
							}
						}
					});
				}
			});
		});

		ui.showProgress($course, false);

		if (missingItems.length === 0) {
			setCourseCompletedStatus($course, true);


			updateCourseStatusTags($course, {
				verifiedStatus: "complete",
				verifiedDetails: `${totalItemsChecked} items intact`,
			});
			saveDownloads(false);
			dialogs.alert(`[Seq #${seqNum}] ${courseName}: All ${totalItemsChecked} files are 100% intact! Download Finished.`, function () {});
			appendLog(`Download Missing Files [Seq #${seqNum}]`, `${courseName}: All ${totalItemsChecked} items are intact.`);
			return;
		}

		// Log missing files and check for un-downloadable items
		let drmBlockedCount = 0;
		let invalidUrlCount = 0;

		missingItems.forEach((item) => {
			if (item.isEncrypted) {
				drmBlockedCount++;
				appendLog(
					`Missing File Un-downloadable [DRM Protected] [Seq #${seqNum}]`,
					`Course: ${courseName}\nLecture: ${item.name}\nReason: Protected by Udemy DRM encryption. Cannot download encrypted video stream.`
				);
			} else if (!item.src && item.type !== "html") {
				invalidUrlCount++;
				appendLog(
					`Missing File Un-downloadable [No URL] [Seq #${seqNum}]`,
					`Course: ${courseName}\nItem: ${item.name}\nReason: Missing or invalid download URL.`
				);
			}
		});

		if (drmBlockedCount > 0) {
			dialogs.alert(
				`[Seq #${seqNum}] ${courseName}: Found ${missingItems.length} missing files, but ${drmBlockedCount} file(s) are DRM Protected and cannot be downloaded.\n\nCheck Logger tab for details!`,
				function () {}
			);
		} else {
			appendLog(
				`Starting Missing Files Download [Seq #${seqNum}]`,
				`Course: ${courseName}\n- Found ${missingItems.length} missing files out of ${totalItemsChecked} total items.\n- Starting download immediately...`
			);
		}

		// Force immediate download execution: clear completed state & stale cache!
		setCourseCompletedStatus($course, false);
		$course.data("isPaused", false);
		$course.data("isQueued", false);
		$course.data("isDownloading", true);
		$course.data("isPreparing", false);

		saveDownloads(false);

		const selectedSubtitle = $course.find('input[name="selectedSubtitle"]').val() || "";
		prepareDownloading($course, selectedSubtitle);
	} catch (error) {
		ui.showProgress($course, false);
		appendLog("EDOWNLOAD_MISSING", error);
		$course.find(".status-text-label").html(translate("Failed to download missing files. Check logger for details."));
	}
}

function startDownload($course, courseData, subTitle = "") {
	const startFn = $course.data("startDownloadFn");
	const cachedCourseData = $course.data("courseData") || courseData;

	$course.data("isDownloading", true);
	$course.data("isPreparing", false);
	$course.data("isQueued", false);
	$course.data("isPaused", false);
	ui.showProgress($course, true);

	const subtitle = (Array.isArray(subTitle) ? subTitle[0] : subTitle).split("|");
	$course.find(".info-downloaded").hide();
	$course.find(".status-text-label").html(translate("Downloading..."));
	$course.find('input[name="selectedSubtitle"]').val(subtitle);
	$course.find('input[name="encryptedvideos"]').val(courseData.encryptedVideos);

	const $clone = $course.clone(true, true);
	$clone.data("isDownloading", true);
	$clone.data("isPreparing", false);
	$clone.data("isQueued", false);
	$clone.data("isPaused", false);
	if (startFn) $clone.data("startDownloadFn", startFn);
	if (cachedCourseData) $clone.data("courseData", cachedCourseData);

	const $downloads = $(".ui.downloads.section .ui.courses.items");
	const $courses = $(".ui.courses.section .ui.courses.items");

	// Update the original element in the DOM if it's already there
	$course.find(".status-text-label").html(translate("Downloading..."));

	if ($course.parents(".courses.section").length) {
		const $downloadItem = $downloads.find("[course-id=" + $course.attr("course-id") + "]");
		if ($downloadItem.length) {
			$downloadItem.replaceWith($clone);
		} else {
			$downloads.prepend($clone);
		}
	} else {
		const $courseItem = $courses.find("[course-id=" + $course.attr("course-id") + "]");
		if ($courseItem.length) {
			$courseItem.replaceWith($clone);
		}
	}
	$course.push($clone[0]);
	$clone.data("isDownloading", true);
	sortDownloads();
	saveDownloads(false);

	const courseName = sanitize(courseData["name"]); //, { replacement: (s) => "? ".indexOf(s) > -1 ? "" : "-", }).trim();
	const $progressCombined = $course.find(".combined.progress");
	const $progressIndividual = $course.find(".individual.progress");

	const $downloadSpeed = $course.find(".download-speed");
	const $downloadSpeedValue = $downloadSpeed.find(".value");
	const $downloadSpeedUnit = $downloadSpeed.find(".download-unit");
	const $downloadQuality = $course.find(".download-quality");

	const downloadDirectory = Settings.downloadDirectory();
	$course.find('input[name="path-downloaded"]').val(`${downloadDirectory}/${courseName}`);
	$course.find(".open-dir.button").show();
	// $course.css("cssText", "padding-top: 35px !important").css("padding-bottom", "25px");

	const $actionButtons = $course.find(".action.buttons");
	const $downloadButton = $actionButtons.find(".download.button");
	const $pauseButton = $actionButtons.find(".pause.button");
	const $resumeButton = $actionButtons.find(".resume.button");

	$downloadButton.addClass("disabled");
	$pauseButton.removeClass("disabled");
	$resumeButton.addClass("disabled");

	$pauseButton.click(() => stopDownload());
	$resumeButton.click(() => resumeDownload());

	let timerDownloader = null;
	const downloader = new Downloader();

	const lectureChapterMap = {};
	let sequenceMap = 0;
	courseData.chapters.forEach((chapter, chapterIndex) => {
		chapter.lectures.forEach((_lecture, lectureIndex) => {
			sequenceMap++;
			lectureChapterMap[sequenceMap] = { chapterIndex, lectureIndex };
		});
	});

	const labelColorMap = {
		144: "brown",
		240: "purple",
		360: "yellow",
		432: "orange",
		480: "teal",
		576: "blue",
		720: "olive",
		1080: "green",
		Highest: "green",
		auto: "red",
		Auto: "red",
		Attachment: "pink",
		Subtitle: "black",
	};

	let downloaded = 0;
	let toDownload = courseData["totalLectures"];

	const enableDownloadStartEnd = Settings.download.enableDownloadStartEnd;
	if (enableDownloadStartEnd) {
		let downloadStart = Math.max(1, Math.min(Settings.download.downloadStart, toDownload));
		let downloadEnd = Math.max(0, Settings.download.downloadEnd);
		downloadEnd = Math.max(downloadStart, downloadEnd == 0 ? toDownload : downloadEnd);

		toDownload = downloadEnd - downloadStart + 1;
	}

	$progressCombined.progress({
		total: toDownload,
		text: {
			active: `${translate("Downloaded")} {value} ${translate("out of")} {total} ${translate("items")}`,
		},
	});

	$progressCombined.progress("reset");
	$downloadSpeed.show();
	$downloadQuality.show();

	if (enableDownloadStartEnd) {
		downloadChapter(lectureChapterMap[downloadStart].chapterIndex, lectureChapterMap[downloadStart].lectureIndex);
	} else {
		downloadChapter(0, 0);
	}

	function stopDownload(isEncrypted) {
		$course.data("isDownloading", false);
		$course.data("isPreparing", false);
		$course.data("isQueued", false);
		$course.data("isPaused", true);

		if (downloader._downloads && downloader._downloads.length) {
			downloader._downloads.forEach((dl) => {
				try {
					if (dl && typeof dl.stop === "function") {
						dl.stop();
					}
				} catch (e) {
					console.warn("dl.stop error:", e.message);
				}
			});
		}

		$pauseButton.addClass("disabled");
		$resumeButton.removeClass("disabled");
		$downloadSpeed.hide().find(".value").html(0);
		$course.find(".status-text-label").html(translate("Paused"));
		$course.find(".download-status").show();

		if (isEncrypted) {
			resetCourse($course, $course.find(".course-encrypted"));
		}

		processDownloadQueue();
		sortDownloads();
		saveDownloads(false);
	}

	function resumeDownload() {
		$course.data("isPaused", false);
		$course.data("isPreparing", false);
		$course.data("isDownloading", true);
		$course.data("isQueued", false);

		let resumedAny = false;
		if (downloader._downloads && downloader._downloads.length) {
			downloader._downloads.forEach((dl) => {
				try {
					if (dl && typeof dl.resume === "function") {
						dl.resume();
						resumedAny = true;
					}
				} catch (e) {
					console.warn("dl.resume error:", e.message);
				}
			});
		}

		if (!resumedAny) {
			const startFn = $course.data("startDownloadFn");
			if (typeof startFn === "function") {
				startFn();
			}
		}

		$pauseButton.removeClass("disabled");
		$resumeButton.addClass("disabled");
		$course.find(".download-status .label").html(translate("Downloading..."));
		$course.find(".download-status").show();

		processDownloadQueue();
		sortDownloads();
		saveDownloads(false);
	}

	function setLabelQuality(label) {
		if (label === undefined || label === null) {
			label = "Auto";
		}
		const strLabel = String(label);
		const currentClass = $downloadQuality.attr("class") || "";
		const lastClass = currentClass.split(" ").pop() || "";
		$downloadQuality
			.html(strLabel + (!isNaN(parseFloat(strLabel)) ? "p" : ""))
			.removeClass(lastClass)
			.addClass(labelColorMap[label] || labelColorMap[strLabel] || "grey");
	}

	function downloadChapter(chapterIndex, lectureIndex) {
		try {
			const countLectures = courseData.chapters[chapterIndex].lectures.length;
			const seqName = utils.getSequenceName(
				chapterIndex + 1,
				courseData.chapters.length,
				sanitize(courseData.chapters[chapterIndex].name.trim()),
				". ",
				downloadDirectory + "/" + courseName
			);

			fs.mkdirSync(seqName.fullPath, { recursive: true });
			downloadLecture(chapterIndex, lectureIndex, countLectures, seqName.name);
		} catch (error) {
			handleApiError(error, "EDOWNLOADING_CHAPTER", null, false);
			resetCourse($course, $course.find(".download-error"), false, courseData);
		}
	}

	async function downloadLecture(chapterIndex, lectureIndex, countLectures, sanitizedChapterName) {
		try {
			if (downloaded == toDownload) {
				resetCourse($course, $course.find(".download-success"));
				VerificationEngine.verifyCourseDownloads($course, {
					onStart: () => {},
					onComplete: ({ isComplete, missingItems }) => {
						if (isComplete) {
							updateCourseStatusTags($course, { verifiedStatus: "complete", verifiedDetails: "100% Intact" });
							$course.find(".download-success").css("display", "flex");
						} else {
							updateCourseStatusTags($course, { verifiedStatus: "missing", verifiedDetails: `${missingItems.length} Missing` });
						}
					},
					onError: (err) => console.error("Verification failed:", err)
				});
				sendNotification(
					downloadDirectory + "/" + courseName,
					courseName,
					$course.find(".ui.tiny.image").find(".course-image").attr("src")
				);
				return;
			} else if (lectureIndex == countLectures) {
				downloadChapter(++chapterIndex, 0);
				return;
			}

			const chapterName = courseData.chapters[chapterIndex].name.trim();
			const lectureData = courseData.chapters[chapterIndex].lectures[lectureIndex];
			const lectureType = lectureData.type.toLowerCase();
			const lectureName = lectureData.name.trim();
			const sanitizedLectureName = sanitize(lectureName);

			function dlStart(dl, typeVideo, callback) {
				// Change retry options to something more forgiving and threads to keep udemy from getting upset
				dl.setRetryOptions({
					maxRetries: 3, // Default: 5
					retryInterval: 3000, // Default: 2000
				});

				// Set download options
				dl.setOptions({
					threadsCount: 8, // Optimized: 8 parallel connections for max speed
					timeout: 10000, // 10s timeout
					range: "0-100",
				});

				dl.start();
				// To track time and restarts
				let notStarted = 0;
				let reStarted = 0;

				timerDownloader = setInterval(function () {
					// Status:
					//   -3 = destroyed
					//   -2 = stopped
					//   -1 = error
					//   0 = not started
					//   1 = started (downloading)
					//   2 = error, retrying
					//   3 = finished
					switch (dl.status) {
						case 0:
							// Wait a reasonable amount of time for the download to start and if it doesn't then start another one.
							// once one of them starts the errors from the others will be ignored and we still get the file.
							if (reStarted <= 5) {
								notStarted++;
								if (notStarted >= 15) {
									dl.start();
									notStarted = 0;
									reStarted++;
								}
							} else {
								console.warn("[dlStart] Download unable to start after retries. Skipping file:", dl?.filePath);
								clearInterval(timerDownloader);
								try {
									if (dl?.filePath && fs.existsSync(dl.filePath + ".mtd")) {
										fs.unlinkSync(dl.filePath + ".mtd");
									}
								} catch (e) {}
								if (typeof callback === "function") {
									callback();
								}
								return;
							}
							$downloadSpeedValue.html(0);
							$downloadSpeedUnit.html("KB/s");
							break;

						case 1:
						case -1:
							const stats = dl.getStats();
							const speedAndUnit = utils.getDownloadSpeed(stats.present.speed || 0);
							$downloadSpeedValue.html(speedAndUnit.value);
							$downloadSpeedUnit.html(speedAndUnit.unit);
							// console.log(`dl~stats.present.speed: ${stats.present.speed}`);
							// console.log(`Download speed: ${speedAndUnit.value}${speedAndUnit.unit}`);
							$progressIndividual.progress("set percent", stats.total.completed);

							if (dl.status === -1) {
								appendLog("Download error, retrying... ", { url: dl.url });
								axios({
									timeout: HTTP_TIMEOUT,
									type: "HEAD",
									url: dl.url,
								})
									.then(() => {
										resetCourse($course, $course.find(".download-error"), Settings.download.autoRetry, courseData, subtitle);
									})
									.catch((error) => {
										handleApiError(error, "EDL_DOWNLOADING_LECTURE", courseData.name, false);
										const statusCode = error.response?.status || 0;
										const unlinkFile = statusCode == 401 || statusCode == 403;
										try {
											if (unlinkFile) {
												fs.unlinkSync(dl.filePath);
											}
										} finally {
											resetCourse(
												$course,
												$course.find(".download-error"),
												Settings.download.autoRetry && !unlinkFile,
												courseData,
												subtitle
											);
										}
									});

								clearInterval(timerDownloader);
							}
							break;

						case 2:
						case -3:
							break;
						default:
							$downloadSpeedValue.html(0);
							$downloadSpeedUnit.html("KB/s");
					}
				}, 1000);

				dl.on("error", function (dl) {
					console.error("dl.on(error)", dl.error.message);
					if (hasDRMProtection(dl)) {
						dl.emit("end");
					} else {
						appendLog("DL_ONERROR", dl.error.message);
					}
				});

				dl.on("start", function () {
					// console.log("dl.on(start)", dl.filePath.split("/").slice(-2).join("/"));
					$pauseButton.removeClass("disabled");
				});

				dl.on("stop", function () {
					console.warn("dl.on(stop)");
				});

				dl.on("end", function () {
					// console.log("dl.on(end)", { path: dl.filePath, typeVideo });
					if (typeVideo && hasDRMProtection(dl)) {
						$course.find('input[name="encryptedvideos"]').val(++courseData.encryptedVideos);

						appendLog(`DRM Protected::${courseData.name}`, dl.filePath);
						fs.unlink(dl.filePath + ".mtd", (err) => {
							if (err) {
								console.error("dl.on(end)__fs.unlink", err.message);
							}
						});

						if (!Settings.download.continueDonwloadingEncrypted) {
							dl.destroy();
							stopDownload(true);
							clearInterval(timerDownloader);
							return;
						}
					}
					callback();
				});
			}

			function downloadAttachments(index, totalAttachments) {
				if (!totalAttachments || index >= totalAttachments || !lectureData.attachments || !lectureData.attachments[index]) {
					$progressCombined.progress("increment");
					downloaded++;
					downloadLecture(chapterIndex, ++lectureIndex, countLectures, sanitizedChapterName);
					return;
				}

				$progressIndividual.progress("reset");

				const attachment = lectureData.attachments[index];
				const attachmentName = (attachment.name || "attachment").trim();

				setLabelQuality(attachment.quality);

				if (["article", "url"].includes(attachment.type)) {
					const wfDir = downloadDirectory + "/" + courseName + "/" + sanitizedChapterName;
					const doneCb = function () {
						index++;
						if (index >= totalAttachments) {
							$progressCombined.progress("increment");
							downloaded++;
							downloadLecture(chapterIndex, ++lectureIndex, countLectures, sanitizedChapterName);
						} else {
							downloadAttachments(index, totalAttachments);
						}
					};

					if (attachment.externalUrl) {
						const filesToWrite = ["html"];
						if (Settings.download.downloadExternalUrls) {
							const format = Settings.download.externalUrlFormat || "txt";
							if (format === "both") {
								filesToWrite.push("txt", "url");
							} else {
								filesToWrite.push(format);
							}
						}

						let pending = filesToWrite.length;
						if (pending === 0) return doneCb();

						filesToWrite.forEach(ext => {
							const seqName = utils.getSequenceName(lectureIndex + 1, countLectures, sanitize(attachmentName) + "." + ext, `.${index + 1} `, wfDir).fullPath;
							let content = "";
							if (ext === "html") {
								content = `<script type="text/javascript">window.location = "${attachment.externalUrl}";</script>`;
							} else if (ext === "txt") {
								content = attachment.externalUrl;
							} else if (ext === "url") {
								content = `[InternetShortcut]\nURL=${attachment.externalUrl}`;
							}
							fs.writeFile(seqName, content, () => {
								pending--;
								if (pending <= 0) doneCb();
							});
						});
					} else {
						fs.writeFile(
							utils.getSequenceName(lectureIndex + 1, countLectures, attachmentName + ".html", `.${index + 1} `, wfDir).fullPath,
							attachment.src || "",
							doneCb
						);
					}
				} else {
					if (!attachment.src || typeof attachment.src !== "string" || !attachment.src.trim() || !attachment.src.startsWith("http")) {
						appendLog("Skip Attachment - Invalid URL", `Attachment: ${attachmentName}`);
						endDownload();
						return;
					}

					let fileExtension = (attachment.src || "").split("/").pop().split("?").shift().split(".").pop() || "";
					fileExtension = attachment.name.split(".").pop() == fileExtension ? "" : (fileExtension ? "." + fileExtension : "");

					const lectureSeqName = utils.getSequenceName(
						lectureIndex + 1,
						countLectures,
						sanitize(attachmentName) + fileExtension,
						`.${index + 1} `,
						`${downloadDirectory}/${courseName}/${sanitizedChapterName}`
					);

					// try deleting the download started without data
					try {
						if (fs.existsSync(lectureSeqName.fullPath + ".mtd") && !fs.statSync(lectureSeqName.fullPath + ".mtd").size) {
							fs.unlinkSync(lectureSeqName.fullPath + ".mtd");
						}
					} catch (e) {}

					let dl;
					try {
						if (fs.existsSync(lectureSeqName.fullPath + ".mtd")) {
							dl = downloader.resumeDownload(lectureSeqName.fullPath);
						} else if (fs.existsSync(lectureSeqName.fullPath) && fs.statSync(lectureSeqName.fullPath).size > 0) {
							endDownload();
							return;
						} else {
							dl = downloader.download(attachment.src, lectureSeqName.fullPath);
						}
					} catch (err) {
						console.error("[downloadAttachments] Downloader instantiation error:", err.message);
						endDownload();
						return;
					}

					if (!dl) {
						endDownload();
						return;
					}

					dlStart(dl, (attachment.type || "").includes("video"), endDownload);

					function endDownload() {
						index++;

						clearInterval(timerDownloader);
						if (index >= totalAttachments) {
							$progressCombined.progress("increment");
							downloaded++;
							downloadLecture(chapterIndex, ++lectureIndex, countLectures, sanitizedChapterName);
						} else {
							downloadAttachments(index, totalAttachments);
						}
					}
				}
			}

			function checkAttachment() {
				$progressIndividual.progress("reset");
				const rawAttachments = lectureData.attachments;
				const attachments = (rawAttachments && Array.isArray(rawAttachments)) ? rawAttachments.filter((att) => att && att.name) : [];

				if (attachments.length > 0) {
					attachments.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
					lectureData.attachments = attachments;
					downloadAttachments(0, attachments.length);
				} else {
					if (lectureData.isEncrypted) {
						appendLog("Video with DRM Protection", `Chapter: ${chapterName}\nLecture: ${lectureName}`);
					}
					$progressCombined.progress("increment");
					downloaded++;
					downloadLecture(chapterIndex, ++lectureIndex, countLectures, sanitizedChapterName);
				}
			}

			function downloadSubtitle() {
				$progressIndividual.progress("reset");

				setLabelQuality("Subtitle");
				$downloadSpeedValue.html(0);

				const subtitleSeqName = utils.getSequenceName(
					lectureIndex + 1,
					countLectures,
					sanitizedLectureName + ".srt",
					". ",
					`${downloadDirectory}/${courseName}/${sanitizedChapterName}`
				);

				if (fs.existsSync(subtitleSeqName.fullPath)) {
					checkAttachment();
					return;
				}

				const vttFile = subtitleSeqName.fullPath.replace(".srt", ".vtt");
				const vttFileWS = fs.createWriteStream(vttFile).on("finish", function () {
					const strFileWS = fs.createWriteStream(subtitleSeqName.fullPath).on("finish", function () {
						try {
							if (fs.existsSync(vttFile)) {
								fs.unlinkSync(vttFile);
							}
						} catch (e) {}
						checkAttachment();
					});

					fs.createReadStream(vttFile).pipe(vtt2srt()).pipe(strFileWS);
				});

				const subtitles = lectureData.subtitles;
				const availables = [];
				$.map(subtitle, function (el) {
					if (el in subtitles) {
						availables.push(el);
					}
				});

				let download_this_sub = availables[0] || Object.keys(subtitles)[0] || "";
				if (availables.length > 1) {
					for (const key of availables) {
						if (availables[key].indexOf("[Auto]") == -1 || availables[key].indexOf(`[${translate("Auto")}]`) == -1) {
							download_this_sub = availables[key];
							break;
						}
					}
				}

				if (subtitles && download_this_sub && subtitles[download_this_sub]) {
					https.get(subtitles[download_this_sub], function (response) {
						response.pipe(vttFileWS);
					});
				} else {
					checkAttachment();
				}
			}

			// read url as string or ArrayBuffer
			async function getFile(url, binary) {
				let retry = 0;
				if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
				while (retry < 3) {
					try {
						const response = await fetch(url);
						const status = response.status;

						if (status >= 200 && status < 300) {
							if (binary) return await response.arrayBuffer();

							return await response.text();
						} else console.warn("getFile_Buffer", response.statusText);
					} catch (error) {
						appendLog("getFile_Error", error);
					}

					retry++;
					if (retry < 3) {
						await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, retry)));
					}
				}

				throw new Error(`Failed to fetch file after 3 attempts: ${url}`);
			}

			// read highest quality playlist
			async function getPlaylist(url) {
				if (!url || typeof url !== "string" || !url.startsWith("http")) return [];
				const playlist = await getFile(url, false);

				if (!playlist) return [];

				const lines = playlist.trim().split("\n");
				const urlList = [];

				lines.forEach((line) => {
					line = line.trim();
					if (line && !line.startsWith("#")) {
						try {
							const fullSegmentUrl = new URL(line, url).href;
							if (fullSegmentUrl.toLowerCase().includes(".ts") || fullSegmentUrl.includes(".aac") || fullSegmentUrl.includes(".mp4") || fullSegmentUrl.includes(".m4s")) {
								urlList.push(fullSegmentUrl);
							}
						} catch (e) {}
					}
				});

				if (urlList.length === 0 && playlist.includes("m3u8")) {
					let maximumQuality = 0;
					let maximumQualityPlaylistUrl = null;
					let getUrl = false;

					for (let line of lines) {
						line = line.trim();
						if (getUrl && line && !line.startsWith("#")) {
							try {
								maximumQualityPlaylistUrl = new URL(line, url).href;
							} catch (e) {}
							getUrl = false;
						}

						const upperLine = line.toUpperCase();
						if (upperLine.includes("EXT-X-STREAM-INF")) {
							if (upperLine.includes("RESOLUTION=")) {
								try {
									const readQuality = parseInt(upperLine.split("RESOLUTION=")[1].split("X")[1].split(",")[0]) || 0;
									if (readQuality > maximumQuality) {
										maximumQuality = readQuality;
										getUrl = true;
									}
								} catch (error) {
									getUrl = true;
								}
							} else {
								getUrl = true;
							}
						}
					}

					if (!maximumQualityPlaylistUrl && lines.length > 0) {
						for (let line of lines) {
							line = line.trim();
							if (line && !line.startsWith("#") && line.toLowerCase().includes("m3u8")) {
								try {
									maximumQualityPlaylistUrl = new URL(line, url).href;
									break;
								} catch (e) {}
							}
						}
					}

					if (maximumQualityPlaylistUrl && maximumQualityPlaylistUrl !== url) {
						if (maximumQuality > 0) setLabelQuality(maximumQuality);
						return await getPlaylist(maximumQualityPlaylistUrl);
					}
				}

				return urlList;
			}

			$progressIndividual.progress("reset");

			const lectureQuality = lectureData.quality;
			setLabelQuality(lectureQuality);

			if (lectureType == "article" || lectureType == "url") {
				const wfDir = `${downloadDirectory}/${courseName}/${sanitizedChapterName}`;
				const doneCb = function () {
					if (lectureData.attachments) {
						lectureData.attachments.sort(utils.dynamicSort("name"));
						const totalAttachments = lectureData.attachments.length;
						let indexador = 0;
						downloadAttachments(indexador, totalAttachments);
					} else {
						$progressCombined.progress("increment");
						downloaded++;
						downloadLecture(chapterIndex, ++lectureIndex, countLectures, sanitizedChapterName);
					}
				};

				if (lectureData.externalUrl) {
					const filesToWrite = ["html"];
					if (Settings.download.downloadExternalUrls) {
						const format = Settings.download.externalUrlFormat || "txt";
						if (format === "both") {
							filesToWrite.push("txt", "url");
						} else {
							filesToWrite.push(format);
						}
					}

					let pending = filesToWrite.length;
					if (pending === 0) return doneCb();

					filesToWrite.forEach(ext => {
						const seqName = utils.getSequenceName(lectureIndex + 1, countLectures, sanitize(lectureName) + "." + ext, ". ", wfDir).fullPath;
						let content = "";
						if (ext === "html") {
							content = `<script type="text/javascript">window.location = "${lectureData.externalUrl}";</script>`;
						} else if (ext === "txt") {
							content = lectureData.externalUrl;
						} else if (ext === "url") {
							content = `[InternetShortcut]\nURL=${lectureData.externalUrl}`;
						}
						fs.writeFile(seqName, content, () => {
							pending--;
							if (pending <= 0) doneCb();
						});
					});
				} else {
					fs.writeFile(
						utils.getSequenceName(lectureIndex + 1, countLectures, sanitizedLectureName + ".html", ". ", wfDir).fullPath,
						lectureData.src || "",
						doneCb
					);
				}
			} else {
				const seqName = utils.getSequenceName(
					lectureIndex + 1,
					countLectures,
					sanitizedLectureName + (lectureType == "file" ? ".pdf" : ".mp4"),
					". ",
					`${downloadDirectory}/${courseName}/${sanitizedChapterName}`
				);

				const skipLecture = Settings.download.type == Settings.DownloadType.OnlyAttachments || Settings.download.type == Settings.DownloadType.OnlyExternalURLs;
				const isFileComplete = fs.existsSync(seqName.fullPath) && fs.statSync(seqName.fullPath).size > 0;
				const isEncryptedLecture = lectureData.isEncrypted || (lectureData.src && String(lectureData.src).includes("encrypted-files"));

				// Refresh stream URL just in time to avoid expired CDN links
				if (!isFileComplete && !skipLecture && !isEncryptedLecture && (lectureType === "application/x-mpegurl" || (lectureType || "").includes("video"))) {
					const courseId = $course.attr("course-id");
					try {
						if (courseId && udemyService) {
							const freshLecture = await udemyService.fetchLecture(courseId, lectureData.id, true, true);
							if (freshLecture) {
								await udemyService._prepareStreamSource(courseId, freshLecture);
								if (freshLecture.asset?.streams?.Video?.[0]?.src) {
									lectureData.src = freshLecture.asset.streams.Video[0].src;
								} else if (freshLecture.asset?.media_sources?.[0]?.src) {
									lectureData.src = freshLecture.asset.media_sources[0].src;
								}
								lectureData.isEncrypted = Boolean(freshLecture.asset?.media_license_token);
							}
						}
					} catch (err) {
						appendLog("JIT URL Refresh Failed", `Lecture: ${lectureName}\nCourseID: ${courseId} LectureID: ${lectureData.id}\nError: ${err.message}`);
						if (err.message.includes("404") || err.message.includes("403")) {
							appendLog("Skip Lecture - API Access Denied/Not Found", `Course: ${courseName}`, `Lecture: ${lectureName}`);
							checkAttachment();
							return;
						}
					}
				}

				if (lectureType !== "application/x-mpegurl") {
					if (isFileComplete || skipLecture || isEncryptedLecture || !lectureData.src || typeof lectureData.src !== "string" || !lectureData.src.trim() || !lectureData.src.startsWith("http")) {
						if (!lectureData.src || typeof lectureData.src !== "string" || !lectureData.src.startsWith("http")) {
							appendLog("Skip Lecture - Invalid or missing URL", `Course: ${courseName}`, `Lecture: ${lectureName}`);
						}
						endDownloadAttachment();
						return;
					}

					if (fs.existsSync(seqName.fullPath + ".mtd") && !fs.statSync(seqName.fullPath + ".mtd").size) {
						fs.unlinkSync(seqName.fullPath + ".mtd");
					}

					if (fs.existsSync(seqName.fullPath + ".mtd")) {
						var dl = downloader.resumeDownload(seqName.fullPath);
					} else {
						var dl = downloader.download(lectureData.src, seqName.fullPath);
					}

					dlStart(dl, (lectureType || "").includes("video"), endDownloadAttachment);
				} else {
					if (isFileComplete || skipLecture || isEncryptedLecture || !lectureData.src || typeof lectureData.src !== "string" || !lectureData.src.trim() || !lectureData.src.startsWith("http")) {
						if (!lectureData.src || typeof lectureData.src !== "string" || !lectureData.src.startsWith("http")) {
							appendLog("Skip Lecture - Invalid or missing m3u8 URL", `Course: ${courseName}`, `Lecture: ${lectureName}`);
						}
						endDownloadAttachment();
						return;
					}
					if (fs.existsSync(seqName.fullPath + ".mtd")) {
						fs.unlinkSync(seqName.fullPath + ".mtd");
					}

					getPlaylist(lectureData.src).then(async (list) => {
						if (list && list.length > 0) {
							try {
								$progressIndividual.progress("reset");

								const BATCH_SIZE = 10;
								let count = 0;
								const segmentBuffers = [];

								for (let i = 0; i < list.length; i += BATCH_SIZE) {
									const batchUrls = list.slice(i, i + BATCH_SIZE);
									const startTime = performance.now();

									const responses = await Promise.all(
										batchUrls.map((url) => m3u8DownloadLimit.run(() => getFile(url, true)))
									);

									const endTime = performance.now();
									const timeDiff = (endTime - startTime) / 1000.0;

									let batchBytes = 0;
									responses.forEach((res) => {
										if (res) {
											batchBytes += res.byteLength;
											segmentBuffers.push(res);
											count++;
										}
									});

									if (timeDiff > 0 && batchBytes > 0) {
										const speedAndUnit = utils.getDownloadSpeed(batchBytes / timeDiff);
										$downloadSpeedValue.html(speedAndUnit.value);
										$downloadSpeedUnit.html(speedAndUnit.unit);
									}

									$progressIndividual.progress("set percent", parseInt((count / list.length) * 100));

									if (segmentBuffers.length >= 40 || i + BATCH_SIZE >= list.length) {
										if (segmentBuffers.length > 0) {
											const blob = new Blob(segmentBuffers, { type: "application/octet-binary" });
											try {
												const data = Buffer.from(await blob.arrayBuffer());
												fs.appendFileSync(seqName.fullPath, data);
												segmentBuffers.length = 0;
											} catch (bufferError) {
												console.error("Error writing video segment buffer:", bufferError);
											}
										}
									}
								}
							} catch (error) {
								console.error("Error processing m3u8 stream:", error);
								try {
									if (fs.existsSync(seqName.fullPath)) {
										fs.unlinkSync(seqName.fullPath);
									}
								} catch (e) {}
								resetCourse($course, $course.find(".download-error"), Settings.download.autoRetry, courseData);
								return; // Abort this download so endDownloadAttachment() is not called
							}
						}

						endDownloadAttachment();
					}).catch((err) => {
						console.error("getPlaylist promise rejection:", err);
						endDownloadAttachment();
					});
				}

				function endDownloadAttachment() {
					clearInterval(timerDownloader);
					if (courseData.chapters[chapterIndex].lectures[lectureIndex].subtitles) {
						downloadSubtitle();
					} else {
						checkAttachment();
					}
				}
			}
		} catch (error) {
			appendLog("downloadLecture_Error:", error);
			captureException(error);

			resetCourse($course, $course.find(".download-error"), false, courseData);
		}
	}

	function hasDRMProtection(dl) {
		try {
			// return !dl.meta.headers["content-type"].includes("video");
			const encrypted = dl.url.includes("encrypted-files");
			if (encrypted) console.warn("Arquivo encriptado", dl);

			return encrypted;
		} catch (error) {
			return false;
		}
	}
}

function findMatchingSubtitle(subtitlesAvailable, targetSubtitle) {
	if (!subtitlesAvailable || !targetSubtitle) return null;

	const cleanTarget = String(targetSubtitle).toLowerCase().replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
	if (!cleanTarget) return null;

	// 1. Exact normalized match
	for (const key in subtitlesAvailable) {
		const cleanKey = String(key).toLowerCase().replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
		if (cleanKey === cleanTarget) {
			return key;
		}
	}

	// 2. Contains or startsWith match
	for (const key in subtitlesAvailable) {
		const cleanKey = String(key).toLowerCase().replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
		if (cleanKey.startsWith(cleanTarget) || cleanTarget.startsWith(cleanKey) || cleanKey.includes(cleanTarget)) {
			return key;
		}
	}

	// 3. Language code / ISO alias mapping
	const langMap = {
		english: ["en", "eng"],
		spanish: ["es", "spa", "espanol", "español"],
		french: ["fr", "fra", "francais", "français"],
		german: ["de", "deu", "deutsch"],
		portuguese: ["pt", "por", "portugues", "português"],
		italian: ["it", "ita", "italiano"],
		turkish: ["tr", "tur", "turkce", "türkçe"],
		arabic: ["ar", "ara"],
		chinese: ["zh", "chi", "zho"],
		japanese: ["ja", "jpn"],
		korean: ["ko", "kor"],
		russian: ["ru", "rus"],
		hindi: ["hi", "hin"],
		indonesian: ["id", "ind"],
	};

	const aliases = langMap[cleanTarget] || [];
	for (const key in subtitlesAvailable) {
		const cleanKey = String(key).toLowerCase().replace(/\s*\[.*?\]/g, "").replace(/\s*\(.*?\)/g, "").trim();
		if (aliases.includes(cleanKey)) {
			return key;
		}
	}

	return null;
}

function askForSubtitle(subtitlesAvailable, totalLectures, defaultSubtitle = "", callback) {
	try {
		if (!subtitlesAvailable || Object.keys(subtitlesAvailable).length === 0) {
			callback("");
			return;
		}
	} catch (error) {
		callback("");
		return;
	}

	const prefSub = Settings.download.defaultSubtitle || defaultSubtitle || "";
	if (prefSub) {
		const matchedKey = findMatchingSubtitle(subtitlesAvailable, prefSub);
		if (matchedKey) {
			console.log(`[askForSubtitle] Matched default subtitle preference "${prefSub}" to available subtitle key "${matchedKey}". Skipping modal prompt.`);
			callback(matchedKey);
			return;
		}
	}

	const subtitleLanguages = [];
	const languages = [];
	const totals = {};
	const languageKeys = {};

	for (const key in subtitlesAvailable) {
		const subtitle = key.replace(/\s*\[.*?\]/g, "").trim();

		if (!(subtitle in totals)) {
			languages.push(subtitle);
			totals[subtitle] = 0;
			languageKeys[subtitle] = [];
		}

		totals[subtitle] += subtitlesAvailable[key];
		languageKeys[subtitle].push(key);
	}

	if (languages.length === 1) {
		const singleKey = languageKeys[languages[0]] ? languageKeys[languages[0]].join("|") : Object.keys(subtitlesAvailable)[0];
		callback(singleKey);
		return;
	} else if (languages.length === 0) {
		callback("");
		return;
	}

	languages.forEach((language) => {
		totals[language] = Math.min(totalLectures, totals[language]);
	});

	languages.sort();
	languages.forEach((language) => {
		subtitleLanguages.push({
			name: `<b>${language}</b> <i>${totals[language]} ${translate("Lectures")}</i>`,
			value: languageKeys[language].join("|"),
		});
	});
	subtitleLanguages.unshift({ name: "", value: "" });

	const $subtitleModal = $(".ui.subtitle.modal");
	const $subtitleDropdown = $subtitleModal.find(".ui.dropdown");

	$subtitleModal.modal({ closable: false }).modal("show");
	$subtitleDropdown.dropdown({
		values: subtitleLanguages,
		onChange: (subtitle) => {
			$subtitleModal.modal("hide");
			$subtitleDropdown.dropdown({ values: [] });
			callback(subtitle);
		},
	});
}

function sendNotification(pathCourse, courseName, urlImage = null) {
	try {
		new Notification(courseName, {
			body: translate("Download Finished"),
			icon: urlImage ?? __dirname + "/assets/images/build/icon.png",
		}).onclick = () => {
			shell.openPath(pathCourse);
		};
	} catch (error) {
		appendLog("sendNotification", error);
	}
}

function clearLogArea() {
	loggers.length = 0;
	$(".ui.logger.section .ui.list").html(`
		<div class="ui info message" id="logger-empty-msg" style="margin: 10px;">
			<i class="info circle icon"></i> ${translate("No log entries yet. Event logs and error tracebacks will appear here automatically.")}
		</div>
	`);
	clearBagdeLoggers();
}

function clearBagdeLoggers() {
	$("#badge-logger").text("0");
	$("#badge-logger").hide();
}

/**
 * Function to append a log entry with the specified title and error.
 *
 * @param {string} title - The title of the log entry.
 * @param {string|Error|object} error - The error message or Error object.
 */
function appendLog(title, error, additionalDescription = "") {
	let description =
		error instanceof Error
			? `${error.message}\n${error.stack}`
			: typeof error == "object"
				? JSON.stringify(error, null, 2)
				: (error || "");

	description += additionalDescription !== "" ? "\n\n" + additionalDescription : "";

	$("#logger-empty-msg").remove();

	const timeStr = new Date().toLocaleTimeString();
	const formattedDesc = String(description)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");

	// item added to list to display
	$(".ui.logger.section .ui.list").prepend(
		`<div class="item" style="padding: 12px; border-bottom: 1px solid #e0e0e0;">
			<div class="header" style="color: #2185d0; font-weight: bold; margin-bottom: 4px;">
				<i class="clock outline icon"></i> [${timeStr}] ${title}
			</div>
			<div style="font-family: monospace; white-space: pre-wrap; word-break: break-all; background: #f8f9fa; padding: 8px 12px; border-radius: 4px; border: 1px solid #e0e0e0; font-size: 12px;">${formattedDesc}</div>
		</div>`
	);

	// item added to array to save txt file
	loggers.unshift({
		datetime: new Date().toLocaleString(),
		title,
		description,
	});

	// increment badge
	const $badge = $("#badge-logger");
	const qtd = (parseInt($badge.text(), 0) || 0) + 1;

	$badge.text(qtd > 99 ? "99+" : qtd);
	$badge.show();

	if (error instanceof Error) {
		console.trace(`[${title}] ${error.message}\n ${error.stack}`);
		captureException(error);
	} else {
		console.warn(`[${title}] ${description}`);
	}
}

function saveLogFile() {
	if (loggers.length == 0) return;

	ipcRenderer.invoke("show-save-dialog", {
			title: "Udeler Log",
			defaultPath: "udeler_logger.txt",
			filters: [{ name: "Text File (*.txt)", fileExtension: ["txt"] }],
		})
		.then((result) => {
			if (!result.canceled) {
				let filePath = result.filePath;
				if (!filePath.endsWith(".txt")) filePath += ".txt";

				let content = `================================================================================\n`;
				content += `UDELER SYSTEM LOG & COURSE AUDIT SUMMARY\n`;
				content += `Exported: ${new Date().toLocaleString()}\n`;
				content += `App Version: v1.14.0\n`;
				content += `================================================================================\n\n`;

				content += `--- COURSE LIST & STATUS SUMMARY ---\n\n`;

				const $allCourses = $(".ui.course.item");
				if ($allCourses.length > 0) {
					$allCourses.each((index, el) => {
						const $c = $(el);
						const courseId = $c.attr("course-id") || "N/A";
						const courseName = $c.find(".coursename").text().trim() || "Unknown Course";
						const seqNum = $c.find('input[name="sequence-number"]').val() || $c.data("sequenceNumber") || (index + 1);
						const isCompleted = $c.attr("course-completed") === "true" || $c.data("completed") === true;
						const historyDate = $c.data("historyDate") || "";
						const verifiedStatus = $c.data("verifiedStatus") || "Not Verified";
						const verifiedDetails = $c.data("verifiedDetails") || "";
						const drmStatus = $c.data("drmStatus") || (Number($c.find('input[name="encryptedvideos"]').val() || 0) > 0 ? "protected" : "Not Checked");
						const drmDetails = $c.data("drmDetails") || "";
						const pathDownloaded = $c.find('input[name="path-downloaded"]').val() || "Default Directory";

						content += `[Seq #${seqNum}] Course: ${courseName} (ID: ${courseId})\n`;
						content += `  - Download Status: ${isCompleted ? `Finished (${historyDate})` : "In Progress / Queued"}\n`;
						content += `  - DRM Protection: ${drmStatus === "free" ? "DRM Free (100% Downloadable)" : drmStatus === "protected" ? `DRM Protected (${drmDetails || "Encrypted videos present"})` : "Not Checked"}\n`;
						content += `  - Verification Status: ${verifiedStatus === "complete" ? `Verified (${verifiedDetails || "Intact"})` : verifiedStatus === "missing" ? `Missing Files (${verifiedDetails})` : "Not Verified"}\n`;
						content += `  - Download Path: ${pathDownloaded}\n\n`;
					});
				} else {
					content += `(No course cards active in current view)\n\n`;
				}

				content += `================================================================================\n`;
				content += `DETAILED CHRONOLOGICAL EVENT LOGS\n`;
				content += `================================================================================\n\n`;

				loggers.forEach((item) => {
					content += `${item.datetime} - ${item.title}: ${item.description}\n`;
				});

				fs.writeFile(filePath, content, (error) => {
					if (error) {
						appendLog("saveLogFile_Error", error);
						return;
					}
					console.log("Log file successfully created!");
				});
			}
		});
}

function handleApiError(error, errorName, courseName = null, triggerThrow = true) {
	error.name = errorName;
	error.code = error.code || "";

	const statusCode = error.response?.status || 0;
	switch (statusCode) {
		case 403:
			error.message = translate("You do not have permission to access this course");
			// prompt.alert(msgError);
			showAlertError(error.message, errorName);
			break;
		case 503:
			error.message = translate("Service is temporarily unavailable. Please wait a few minutes and try again.");
			showAlertError(error.message, errorName);
			break;
		case 504:
			error.message = "Gateway timeout";
			showAlertError(error.message, errorName);
			break;
		default:
			break;
	}

	if (courseName) error.message += `\n\n course: ${courseName}`;

	appendLog(`${errorName}: ${error.code}(${statusCode})`, error);

	if (triggerThrow) {
		// throw utils.newError(errorName, error.message);
		throw error;
	}
}

// PHASE 1: showAlertError() — Replaced remote.dialog.showErrorBox()
// with IPC send to main process handler
function showAlertError(message, title = "") {
	title = title ? `.:: ${title} ::.` : ".:: Error ::.";
	ipcRenderer.send("show-error-box", { title, message });
}

function showAlert(message, title = "") {
	if (title) title = `.:: ${title} ::.\n\r`;
	dialogs.alert(`${title}${message}`);
}

function captureException(exception) {
	if (Sentry) Sentry.captureException(exception);
}

process.on("uncaughtException", (error) => {
	appendLog("EPROCESS_UNCAUGHT_EXCEPTION", error);
	captureException(error);
});

process.on("unhandledRejection", (error) => {
	appendLog("EPROCESS_UNHANDLED_REJECTION", error);
	captureException(error);
});

// console.table(getAllDownloadsHistory());
checkLogin(false);
