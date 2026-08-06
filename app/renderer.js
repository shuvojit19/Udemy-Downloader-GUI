"use strict";

// PHASE 1 POLYFILL: Several third-party libraries (Sentry, electron-settings)
// still depend on `electron.remote.app` during their initialization.
// Since we set `enableRemoteModule: false` in main.js, this polyfill provides
// the exact properties they need via synchronous IPC to prevent renderer crashes.
// This will be removed in Step 2 when dependencies are upgraded.
const _electron = require("electron");
_electron.remote = {
	app: {
		getPath: (name) => _electron.ipcRenderer.sendSync("get-path-sync", name),
		name: _electron.ipcRenderer.sendSync("get-app-name-sync"),
		getName: () => _electron.ipcRenderer.sendSync("get-app-name-sync"),
	}
};

const Sentry = require("@sentry/electron");
const Gettings = require("./helpers/settings.js");
const { version: appVersion, vars: pkgVars } = require("../package.json");

let featToggle = {};

if (!process.env.DEBUG_MODE) {
	fetch(pkgVars.urlToggles)
		.then((resp) => resp.json())
		.then((json) => {
			featToggle = json;
			Sentry.init({ dsn: featToggle.enableSentry ? process.env.SENTRY_DSN : "" });
			console.log(featToggle.enableSentry ? "Sentry is enabled" : "Sentry is disabled");
		});
}

const localeMeta = require("./locale/meta.json");
let localeJson;

function translate(text) {
	const language = Gettings.language;

	if (language == "English") {
		return text;
	} else {
		try {
			if (!localeJson) {
				localeJson = require(`./locale/${localeMeta[language]}`);
			}

			return localeJson[text] || text;
		} catch (e) {
			console.error(e);
			return text;
		}
	}
}

function translateWrite(text) {
	document.write(translate(text));
}

function urlDonate() {
	return `${pkgVars.urlDonate}&item_name=${translate("Udeler is free and without any ads. If you appreciate that, please consider donating to the Developer.").replace(" ", "+")}`;
}
