"use strict";

process.noDeprecation = true;

const { shell, remote, ipcRenderer } = require("electron");
const { dialog, BrowserWindow } = remote;
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

const PAGE_SIZE = 25;
const MSG_DRM_PROTECTED = translate("Contains DRM protection and cannot be downloaded");
const HTTP_TIMEOUT = 600000; // 600 segundos (10 min)

const loggers = [];
let repoAccount = "heliomarpm";
let udemyService;

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
	verifyCourseDownloads($(this).parents(".course"));
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
		maxConcurrentDownloads,
	};

	Settings.language = language;

	processDownloadQueue();
	showAlert(translate("Settings Saved"));
}

function selectDownloadPath() {
	const path = dialog.showOpenDialogSync({
		properties: ["openDirectory"],
	});

	if (path && path[0]) {
		fs.access(path[0], fs.constants.R_OK && fs.constants.W_OK, function (err) {
			if (err) {
				showAlert(translate("Cannot select this folder"));
			} else {
				$settingsForm.find('input[name="downloadpath"]').val(path[0]);
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

function loginWithUdemy() {
	const $formLogin = $(".ui.login .form");

	if ($formLogin.find('input[name="business"]').is(":checked")) {
		if (!ui.$subdomainField.val()) {
			showAlert("Type Business Name");
			return;
		}
	} else {
		ui.$subdomainField.val(null);
	}

	const parent = remote.getCurrentWindow();
	const dimensions = parent.getSize();
	const session = remote.session;
	let udemyLoginWindow = new BrowserWindow({
		width: dimensions[0] - 100,
		height: dimensions[1] - 100,
		parent,
		modal: true,
	});

	session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["*://*.udemy.com/*"] }, function (request, callback) {
		const token = request.requestHeaders.Authorization
			? request.requestHeaders.Authorization.split(" ")[1]
			: cookie.parse(request.requestHeaders.Cookie || "").access_token;

		if (token) {
			Settings.accessToken = token;
			Settings.subDomain = new URL(request.url).hostname.split(".")[0];

			udemyLoginWindow.destroy();
			session.defaultSession.clearStorageData();
			session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["*://*.udemy.com/*"] }, function (request, callback) {
				callback({ requestHeaders: request.requestHeaders });
			});
			checkLogin();
		}
		callback({ requestHeaders: request.requestHeaders });
	});

	Settings.subDomain = ui.$subdomainField.val() ?? "www";

	if (ui.$subdomainField.val()) {
		udemyLoginWindow.loadURL(`https://${Settings.subDomain}.udemy.com`);
	} else {
		udemyLoginWindow.loadURL("https://www.udemy.com/join/login-popup");
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

let globalSequenceCounter = 1;

function getNextSequenceNumber(existingSeq) {
	if (existingSeq !== undefined && existingSeq !== null && Number(existingSeq) > 0) {
		const seq = Number(existingSeq);
		if (seq >= globalSequenceCounter) {
			globalSequenceCounter = seq + 1;
		}
		return seq;
	}
	return globalSequenceCounter++;
}

function createCourseElement(courseCache, downloadSection = false) {
	courseCache.completed = courseCache.completed || false;
	courseCache.infoDownloaded = "";
	courseCache.encryptedVideos = 0;
	courseCache.pathDownloaded = "";
	courseCache.name = courseCache.name || courseCache.title;
	courseCache.sequenceNumber = getNextSequenceNumber(courseCache.sequenceNumber);

	const history = Settings.downloadHistory.find((x) => Number(x.id) === Number(courseCache.id));
	if (history) {
		courseCache.infoDownloaded = translate(history.completed ? "Download finished on" : "Download started since") + " " + history.date;
		courseCache.completed = history.completed ? true : courseCache.completed;
		courseCache.encryptedVideos = Math.max(courseCache.encryptedVideos, history.encryptedVideos);
		courseCache.selectedSubtitle = history.selectedSubtitle ?? "";
		courseCache.pathDownloaded = history.pathDownloaded ?? "";
		if (history.sequenceNumber && !courseCache.sequenceNumber) {
			courseCache.sequenceNumber = getNextSequenceNumber(history.sequenceNumber);
		}
	}

	// Se o caminho não existir, obtenha o caminho de configurações de download para o título do curso
	if (!fs.existsSync(courseCache.pathDownloaded)) courseCache.pathDownloaded = Settings.downloadDirectory(sanitize(courseCache.name));

	const tagDismiss = `<a class="ui basic dismiss-download">&nbsp;&nbsp;&nbsp;${translate("Dismiss")}</a>`;

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
                <div class="ui tiny icon green download-success message">
                    <i class="check icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${translate("Download Finished")}</h4>
                        </div>
                        <p>${translate("Click to dismiss")}</p>
                    </div>
                </div>
                <div class="ui tiny icon red download-error message">
                    <i class="bug icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${translate("Download Failed")}</h4>
                        </div>
                        <p>${translate("Click to retry")}</p>
                    </div>
                </div>
                <div class="ui tiny icon purple course-encrypted message">
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

	if (!downloadSection) {
		if (courseCache.completed) {
			resetCourse($course, $course.find(".download-success"));
		} else if (courseCache.encryptedVideos > 0) {
			resetCourse($course, $course.find(".course-encrypted"));
		} else {
			$course.find(".info-downloaded").html(courseCache.infoDownloaded).css("color", "#6d05e8").show();
		}
	} else {
		if (!courseCache.completed) {
			$course.find(".individual.progress").progress("set percent", courseCache.individualProgress).css("display", "block");
			$course.find(".combined.progress").progress("set percent", courseCache.combinedProgress).css("display", "block");
			$course.find(".download-status .label").html(courseCache.progressStatus);

			$course.find(".info-downloaded").hide();
			// $course.css("padding-bottom", "25px");
		} else {
			$course.find(".info-downloaded").html(courseCache.infoDownloaded).css("color", "#48ca56").show();
		}
	}

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

function getActiveDownloadCount() {
	let activeCount = 0;
	const $downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");
	$downloads.each((_index, element) => {
		const $item = $(element);
		const isDownloading = $item.data("isDownloading") === true || ($item.find(".download-status").is(":visible") && $item.find(".pause.button").is(":visible") && !$item.find(".pause.button").hasClass("disabled"));
		const isPreparing = $item.data("isPreparing") === true;
		if (isDownloading || isPreparing) {
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
		$item.find(".download-status .label").html(`${translate("Queued")} #${queueRank}`);
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
		$nextItem.find(".download-status .label").html(translate("Downloading..."));
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

function resetCourse($course, $elMessage, autoRetry, courseData, subtitle) {
	$course.data("isDownloading", false);
	$course.data("isPreparing", false);
	$course.data("isQueued", false);

	if ($elMessage.hasClass("download-success")) {
		$course.attr("course-completed", true);
	} else {
		$course.attr("course-completed", "");

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
		const downloadAttachments = downloadType === Settings.DownloadType.Both || downloadType === Settings.DownloadType.OnlyAttachments;

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

				chapterData.lectures.push({
					type: "url",
					name: item.title,
					src: `<script type="text/javascript">window.location = "${srcUrl}";</script>`,
					quality: "Attachment",
				});
				courseData.totalLectures++;
			} else {
				const lecture = { type, name: item.title, src: "", quality: Settings.download.videoQuality, isEncrypted: false };
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

						lecture.src = streams.sources[lecture.quality]?.url || "";
						lecture.type = streams.sources[lecture.quality]?.type || "video/mp4";
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

				if (downloadAttachments && supplementary_assets && supplementary_assets.length > 0) {
					const attachments = (lecture.attachments = []);

					supplementary_assets.forEach((attachment) => {
						const type = attachment.download_urls ? "file" : "url";
						const src = attachment.download_urls && attachment.download_urls[attachment.asset_type]
							? attachment.download_urls[attachment.asset_type][0].file
							: `<script type="text/javascript">window.location = "${attachment.external_url}";</script>`;

						attachments.push({ type, name: attachment.title, src, quality: "Attachment" });
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

function addDownloadHistory(courseId, courseName, completed = false, encryptedVideos = 0, selectedSubtitle = "", pathDownloaded = "", sequenceNumber = 0) {
	courseId = Number(courseId);
	courseName = String(courseName) || "";
	completed = Boolean(completed);
	encryptedVideos = Number(encryptedVideos);
	selectedSubtitle = String(selectedSubtitle) || "";
	pathDownloaded = String(pathDownloaded) || "";
	sequenceNumber = Number(sequenceNumber) || 0;

	const items = Settings.downloadHistory;
	const index = items.findIndex((x) => Number(x.id) === courseId);

	if (index !== -1) {
		const item = items[index];
		item.id = courseId;
		item.name = courseName;
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
				progressStatus: $el.find(".download-status .label").text() || "",
				encryptedVideos: Number($el.find('input[name="encryptedvideos"]').val() || 0),
				selectedSubtitle: $el.find('input[name="selectedSubtitle"]').val() || "",
				pathDownloaded: $el.find('input[name="path-downloaded"]').val() || "",
				sequenceNumber: sequenceNumber,
			};

			downloadedCourses.push(courseData);
			addDownloadHistory(
				courseData.id,
				courseData.name,
				courseData.completed,
				courseData.encryptedVideos,
				courseData.selectedSubtitle,
				courseData.pathDownloaded,
				courseData.sequenceNumber
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
        dialog
		.showSaveDialog({
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
				processDownloadQueue();
				sortDownloads();
			})
			.catch((e) => {
				console.trace("Error adding courses:", e);
				ui.busyLoadDownloads(false);
			});
	}
}

async function prepareDownloading($course, subtitle) {
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
		};
		$downloadItem = createCourseElement(courseObj, true);
		$downloads.prepend($downloadItem);
	}

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

		const activeCount = getActiveDownloadCount();
		const maxConcurrent = Settings.download.maxConcurrentDownloads || 4;

		if (activeCount >= maxConcurrent) {
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

			console.log(`[prepareDownloading] Fetched details for course ${courseId}. Queued & Auto-paused (Active: ${activeCount}/${maxConcurrent})`);
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
	const courseId = String($course.attr("course-id") || "").trim();
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;

	if (!courseId) return;

	$course.find(".download-success").hide();
	$course.find(".download-error").hide();
	$course.find(".course-encrypted").hide();

	$course.find(".download-status .label").html(translate("Verifying course files..."));
	$course.find(".download-status").show();
	ui.showProgress($course, true);

	let courseData = $course.data("courseData");
	try {
		if (!courseData) {
			courseData = await fetchCourseContent(courseId, courseName, courseUrl);
			if (!courseData) {
				$course.find(".download-status .label").html(translate("Failed to fetch course details for verification."));
				ui.showProgress($course, false);
				return;
			}
			$course.data("courseData", courseData);
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

		ui.showProgress($course, false);

		if (missingItems.length === 0) {
			$course.find(".download-status .label").html(`${translate("Verified Complete")} (${totalItemsChecked} ${translate("items present")})`).css("color", "#48ca56");
			$course.attr("course-completed", true);
			$course.find(".download-success").show();
			$course.find(".download-status").show();
			appendLog("Course Verification", `Course: ${courseName}\nStatus: Verified 100% Complete! (${totalItemsChecked} items intact)`);
			saveDownloads(false);
		} else {
			appendLog("Course Verification", `Course: ${courseName}\nStatus: ${missingItems.length} missing items detected out of ${totalItemsChecked}. Re-downloading missing files...`);
			$course.find(".download-status .label").html(`${translate("Missing")} ${missingItems.length} ${translate("files — Re-downloading missing items...")}`);
			$course.attr("course-completed", "");
			prepareDownloading($course, $course.find('input[name="selectedSubtitle"]').val());
		}
	} catch (error) {
		ui.showProgress($course, false);
		appendLog("EVERIFY_COURSE", error);
		$course.find(".download-status .label").html(translate("Verification failed. Check logger for details."));
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
		$course.find(".download-status .label").html(translate("Paused"));
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

	function downloadLecture(chapterIndex, lectureIndex, countLectures, sanitizedChapterName) {
		try {
			if (downloaded == toDownload) {
				resetCourse($course, $course.find(".download-success"));
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
					threadsCount: 5, // Default: 2, Set the total number of download threads
					timeout: 5000, // Default: 5000, If no data is received, the download times out (milliseconds)
					range: "0-100", // Default: 0-100, Control the part of file that needs to be downloaded.
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

							if (dl.status === -1 && dl.stats.total.size == 0 && fs.existsSync(dl.filePath)) {
								dl.emit("end");
								clearInterval(timerDownloader);
							} else if (dl.status === -1) {
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
					fs.writeFile(
						utils.getSequenceName(lectureIndex + 1, countLectures, attachmentName + ".html", `.${index + 1} `, wfDir).fullPath,
						attachment.src || "",
						function () {
							index++;
							if (index >= totalAttachments) {
								$progressCombined.progress("increment");
								downloaded++;
								downloadLecture(chapterIndex, ++lectureIndex, countLectures, sanitizedChapterName);
							} else {
								downloadAttachments(index, totalAttachments);
							}
						}
					);
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
						} else if (fs.existsSync(lectureSeqName.fullPath)) {
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
						fs.unlinkSync(vttFile);
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
				}

				return null;
			}

			// read highest quality playlist
			async function getPlaylist(url) {
				if (!url || typeof url !== "string" || !url.startsWith("http")) return [];
				const playlist = await getFile(url, false);

				if (!playlist) return [];

				const lines = playlist.trim().split("\n");
				const urlList = [];

				lines.forEach((line) => {
					if (line.toLowerCase().indexOf(".ts") > -1) urlList.push(line);
				});

				if (urlList.length == 0 && playlist.indexOf("m3u8") > 0) {
					let maximumQuality = 0;
					let maximumQualityPlaylistUrl;
					let getUrl = false;

					for (let line of lines) {
						if (getUrl) {
							maximumQualityPlaylistUrl = line;
							getUrl = false;
						}

						line = line.toUpperCase();

						if (line.indexOf("EXT-X-STREAM-INF") > -1 && line.indexOf("RESOLUTION") > -1) {
							try {
								const readQuality = parseInt(line.split("RESOLUTION=")[1].split("X")[1].split(",")[0]) || 0;

								if (readQuality > maximumQuality) {
									maximumQuality = readQuality;
									getUrl = true;
								}
							} catch (error) {
								appendLog("getPlaylist_Error", error);
								captureException(error);
							}
						}
					}

					if (maximumQuality > 0) {
						setLabelQuality(maximumQuality);
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
				fs.writeFile(
					utils.getSequenceName(lectureIndex + 1, countLectures, sanitizedLectureName + ".html", ". ", wfDir).fullPath,
					lectureData.src || "",
					function () {
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
					}
				);
			} else {
				const seqName = utils.getSequenceName(
					lectureIndex + 1,
					countLectures,
					sanitizedLectureName + (lectureType == "file" ? ".pdf" : ".mp4"),
					". ",
					`${downloadDirectory}/${courseName}/${sanitizedChapterName}`
				);

				const skipLecture = Settings.download.type == Settings.DownloadType.OnlyAttachments;

				if (lectureType !== "application/x-mpegurl") {
					if (fs.existsSync(seqName.fullPath) || skipLecture || lectureData.isEncrypted || !lectureData.src || typeof lectureData.src !== "string" || !lectureData.src.trim() || !lectureData.src.startsWith("http")) {
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
					if (fs.existsSync(seqName.fullPath) || skipLecture || lectureData.isEncrypted || !lectureData.src || typeof lectureData.src !== "string" || !lectureData.src.trim() || !lectureData.src.startsWith("http")) {
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
						if (list.length > 0) {
							try {
								$progressIndividual.progress("reset");

								// Define o tamanho do bloco de dados a ser processado por vez
								const CHUNK_SIZE = 100;
								let count = 0;

								for (let i = 0; i < list.length; i += CHUNK_SIZE) {
									const chunk = list.slice(i, i + CHUNK_SIZE);
									const result = [];

									for (const url of chunk) {
										const startTime = performance.now();
										const response = await getFile(url, true);
										const endTime = performance.now();
										const timeDiff = (endTime - startTime) / 1000.0;

										if (response) {
											const chunkSize = response.byteLength;
											const speedAndUnit = utils.getDownloadSpeed(chunkSize / timeDiff);

											$downloadSpeedValue.html(speedAndUnit.value);
											$downloadSpeedUnit.html(speedAndUnit.unit);

											result.push(response);
											count++;
										} else {
											console.error("Received an invalid or null response for URL:", url);
											throw new Error("Invalid or null response received");
										}

										$progressIndividual.progress("set percent", parseInt((count / list.length) * 100));
									}

									const blob = new Blob(result, { type: "application/octet-binary" });
									try {
										const data = Buffer.from(await blob.arrayBuffer());
										fs.appendFileSync(seqName.fullPath, data); // Use append para adicionar os dados ao arquivo existente
									} catch (bufferError) {
										console.error("Error creating buffer from Blob:", bufferError);
										throw bufferError;
									}
								}
							} catch (error) {
								console.error("Error downloading buffer from Blob:", error);
								throw error;
							}
						}

						endDownloadAttachment();
						return;
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

function askForSubtitle(subtitlesAvailable, totalLectures, defaultSubtitle = "", callback) {
	const subtitleLanguages = [];
	const languages = [];
	const totals = {};
	const languageKeys = {};

    try {
        if (subtitlesAvailable && Object.keys(subtitlesAvailable).length === 0) {
            callback("");
            return;
        }
    } catch (error) {
        return;
    }

	defaultSubtitle = defaultSubtitle.replace(/\s*\[.*?\]/g, "").trim();
	for (const key in subtitlesAvailable) {
		const subtitle = key.replace(/\s*\[.*?\]/g, "").trim();

		// default subtitle exists
		if (subtitle === defaultSubtitle) {
			callback(key);
			return;
		}

		if (!(subtitle in totals)) {
			languages.push(subtitle);
			totals[subtitle] = 0;
			languageKeys[subtitle] = [];
		}

		totals[subtitle] += subtitlesAvailable[key];
		languageKeys[subtitle].push(key);
	}

	if (languages.length === 1) {
		callback(languageKeys[0]);
		return;
	} else if (languages.length === 0) {
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

	dialog
		.showSaveDialog({
			title: "Udeler Log",
			defaultPath: "udeler_logger.txt",
			filters: [{ name: "Text File (*.txt)", fileExtension: ["txt"] }],
		})
		.then((result) => {
			if (!result.canceled) {
				let filePath = result.filePath;
				if (!filePath.endsWith(".txt")) filePath += ".txt";

				let content = "";

				loggers.forEach((item) => {
					content += `${item.datetime} - ${item.title}: ${item.description}\n`;
				});

				fs.writeFile(filePath, content, (error) => {
					if (error) {
						appendLog("saveLogFile_Error", error);
						return;
					}
					console.log("File successfully create!");
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

function showAlertError(message, title = "") {
	title = title ? `.:: ${title} ::.` : ".:: Error ::.";
	dialog.showErrorBox(title, message);
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
