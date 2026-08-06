"use strict";

const ui = {
	navSidebar: (tab, tabName) => {
		$(".content .ui.section").hide();
		$(`.content .ui.${tabName}.section`).show();
		$(tab).parent(".sidebar").find(".active").removeClass("active purple");
		$(tab).addClass("active purple");
	},
	busyOff: () => {
		$(".ui .dimmer").removeClass("active");
	},
	busy: (isActive, text) => {
		const $busyDimmer = $(".ui.dashboard .dimmer");
		$busyDimmer.find(".ui.big.text.loader").text(text);
		if (isActive) {
			$busyDimmer.addClass("active");
		} else {
			$busyDimmer.removeClass("active");
		}
	},
	busyLogin: (isActive) => {
		const $busyDimmer = $(".ui.login.dimmer");
		if (isActive) {
			$busyDimmer.addClass("active");
		} else {
			$busyDimmer.removeClass("active");
		}
	},
	busyLogout: (isActive) => {
		ui.busy(isActive, translate("Logging Out"));
	},
	busyCheckUpdate: (isActive) => {
		ui.busy(isActive, translate("Checking for Updates"));
	},
	busyLoadCourses: (isActive) => {
		ui.busy(isActive, translate("Loading Courses"));
	},
	busyBuildingCourseData: (isActive) => {
		ui.busy(isActive, translate("Getting Info"));
	},
	busyLoadDownloads: (isActive) => {
		ui.busy(isActive, translate("Loading Downloads"));
	},
	busySavingHistory: (isActive) => {
		ui.busy(isActive, translate("Saving download history"));
	},
	showModalUpdate: () => {
		$(".ui.update-available.modal").modal("show");
	},
	showDashboard: () => {
		$(".ui.login.grid").slideUp("fast");
		$(".ui.dashboard").fadeIn("fast").css("display", "flex");
	},
	resetToLogin: () => {
		$(".ui.dimmer").removeClass("active");
		$(".ui.dashboard .courses.items").empty();
		$(".content .ui.section").hide();
		$(".content .ui.courses.section").show();
		$(".sidebar").find(".active").removeClass("active purple");
		$(".sidebar").find(".courses-sidebar").addClass("active purple");
		$(".ui.login.grid").slideDown("fast");
		$(".ui.dashboard").fadeOut("fast");
	},
	toggleSubdomainField: (isVisible) => {
		const $subdomainField = $(".ui.login #divsubdomain");
		isVisible ? $subdomainField.show() : $subdomainField.hide();
	},
	get $subdomainField() {
		return $(".ui.login #subdomain");
	},
	get actionCardTemplate() {
		return `
            <div class="ui tiny icon action buttons">
                <button class="ui basic blue save_m3u button" title="Save M3U Playlist"><i class="save outline icon"></i></button>
                <div style="height: 1px; width: 5px;"></div>
                <button class="ui basic blue download button" title="Download Course"><i class="download icon"></i></button>
                <button class="ui basic red disabled pause button" title="Pause Download"><i class="pause icon"></i></button>
                <button class="ui basic green disabled resume button" title="Resume Download"><i class="play icon"></i></button>

                <div style="height: 1px; width: 5px;"></div>

                <button class="ui basic yellow open-in-browser button" title="Open in Browser"><i class="desktop icon"></i></button>
                <button class="ui basic teal open-dir button" title="Open Downloads Directory"><i class="folder open icon"></i></button>
                <button class="ui basic purple verify button" title="Verify Course Files"><i class="shield check icon"></i></button>
                <button class="ui basic orange check-drm button" title="Check DRM & Encryption Status"><i class="lock icon"></i></button>
                <button class="ui basic red download-missing button" title="Download Missing Files Immediately"><i class="download icon"></i></button>
            </div>
            <div class="course-status-tags" style="margin-top: 8px; margin-bottom: 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;"></div>
            <div class="ui horizontal divider" style="margin: 6px 0;"></div>
            <progress class="prepare-downloading" style="width: 100%; display: none;"></progress>
            <div class="ui tiny indicating individual progress">
                <div class="bar"></div>
            </div>
            <div class="ui horizontal divider" style="margin: 6px 0;"></div>
            <div class="ui small indicating combined progress">
                <div class="bar">
                    <div class="progress"></div>
                </div>
                <div class="label status-text-label">${translate("Building Course Data")}</div>
            </div>`;
	},
	prepareDownloading: ($courseCard) => {
		$courseCard.find(".prepare-downloading").show();
		$courseCard.find(".ui.progress").hide();

		$courseCard.find(".individual.progress").progress("reset");
		$courseCard.find(".combined.progress").progress("reset");

		$courseCard.find(".download-quality").html("").hide();
		$courseCard.find(".download-speed").hide().find(".value").html(0);
		$courseCard.find(".download-error").hide();
		$courseCard.find(".course-encrypted").hide();
		$courseCard.find(".download-status").show();
		$courseCard.find(".info-downloaded").hide();
		$courseCard.find(".icon-encrypted").hide();
		$courseCard.find(".ui.tiny.image .tooltip").hide();
		$courseCard.find(".ui.tiny.image").removeClass("wrapper");
	},
	showProgress: ($courseCard, shouldShow) => {
		$courseCard.find(".prepare-downloading").hide();
		$courseCard.find(".individual.progress").hide();

		const $combinedProgress = $courseCard.find(".combined.progress");
		if (shouldShow) {
			$courseCard.find(".ui.progress").show();
		} else {
			// Keep combined progress bar visible if it has been initialized with progress
			const hasProgress = $combinedProgress.find(".progress").text() || $combinedProgress.find(".label").text().includes(translate("Downloaded"));
			if (hasProgress) {
				$combinedProgress.show();
			} else {
				$combinedProgress.hide();
			}
		}
	},
	configureEncryptedIcon($courseCard) {
		if (Number($courseCard.find("input[name='encryptedvideos']").val()) === 0) {
			$courseCard.find(".icon-encrypted").hide();
			$courseCard.find(".ui.tiny.image .tooltip").hide();
			$courseCard.find(".ui.tiny.image").removeClass("wrapper");
		} else {
			$courseCard.find(".icon-encrypted").show();
			$courseCard.find(".ui.tiny.image .tooltip").show();
			$courseCard.find(".ui.tiny.image").addClass("wrapper");
		}
	},
};

module.exports = ui;
