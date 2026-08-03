"use strict";

class M3U8Service {
	/**
	 * Creates a new instance of M3U8Playlist.
	 * @param {string} m3u8Url - The URL of the M3U8 playlist.
	 * @returns {M3U8Service} - The newly created M3U8Playlist instance.
	 */
	constructor(m3u8Url) {
		if (!this._isValidUrl(m3u8Url)) {
			throw new Error("Invalid URL");
		}
		this._m3u8Url = m3u8Url;
		/** @type {Array<{quality: number, resolution: string, url: string}>} */
		this._playlist = [];
	}

	/**
	 * Validates the URL.
	 * @param {string} url - The URL to validate.
	 * @returns {boolean} - True if the URL is valid, false otherwise.
	 */
	_isValidUrl(url) {
		try {
			new URL(url);
			return true;
		} catch (_) {
			return false;
		}
	}

	/**
	 * Checks if the content is a valid M3U8 playlist.
	 * @param {string} content - The content to check.
	 * @returns {boolean} - True if the content is a valid M3U8 playlist, false otherwise.
	 */
	_isValidM3U8Content(content) {
		return content.startsWith("#EXTM3U");
	}

	/**
	 * Extracts URLs and qualities from an M3U8 playlist content.
	 * @param {string} m3u8Content - The content of the M3U8 playlist.
	 * @returns {Array<{quality: number, resolution: string, url: string}>} - An array of objects containing the quality,
	 * resolution, and URL of each playlist.
	 */
	_extractUrlsAndQualities(m3u8Content) {
		const lines = m3u8Content.split("\n");
		const urlsAndQualities = [];

		let currentResolution = null;
		let currentQuality = null;

		lines.forEach((line) => {
			if (line.startsWith("#EXT-X-STREAM-INF")) {
				const match = line.match(/RESOLUTION=(\d+x\d+)/);
				if (match) {
					currentResolution = match[1];
					currentQuality = parseInt(match[1].split("x")[1], 10);
				}
			} else if (line.startsWith("http")) {
				if (currentResolution) {
					urlsAndQualities.push({
						quality: currentQuality,
						resolution: currentResolution,
						url: line,
					});
					currentResolution = null;
					currentQuality = null;
				}
			}
		});

		return urlsAndQualities;
	}

	/**
	 * Fetches a file from the given URL.
	 *
	 * @param {string} url - The URL of the file to fetch.
	 * @param {boolean} [isBinary=false] - Whether the file is binary or text.
	 * @param {number} [maxRetries=3] - The maximum number of retries to fetch the file.
	 * @returns {Promise<string|ArrayBuffer>} - A promise that resolves with the file content.
	 * @throws {Error} - If the file fails to load after multiple attempts.
	 */
	static async getFile(url, isBinary = false, maxRetries = 3) {
		let retries = 0;

		while (retries < maxRetries) {
			try {
				const response = await fetch(url);

				if (!response.ok) {
					throw new Error(`Failed to fetch ${isBinary ? "binary" : "text"} file: ${response.statusText}`);
				}

				return isBinary ? await response.arrayBuffer() : await response.text();
			} catch (error) {
				retries++;
			}
		}

		throw new Error("Failed to load file after multiple attempts");
	}

	/**
	 * Loads the M3U8 playlist.
	 *
	 * @param {number} [maxRetries=3] - The maximum number of retries to fetch the playlist.
	 * @returns {Promise<void>} - A promise that resolves when the playlist is loaded successfully.
	 * @throws {Error} - If the playlist fails to load after multiple attempts.
	 */
	async loadPlaylist(maxRetries = 3) {
		const playlistContent = await M3U8Service.getFile(this._m3u8Url, false, maxRetries);
		if (!this._isValidM3U8Content(playlistContent)) {
			throw new Error("Invalid M3U8 playlist content");
		}
		this._playlist = this._extractUrlsAndQualities(playlistContent);
		return this._playlist;
	}

	/**
	 * Retrieves the playlist.
	 *
	 * @return {Array<{quality: number, resolution: string, url: string}>} The playlist.
	 */
	getPlaylist() {
		return this._playlist;
	}

	_sortPlaylistByQuality(ascending = true) {
		return [...this._playlist].sort((a, b) => {
			const heightA = parseInt(a.resolution.split("x")[1], 10);
			const heightB = parseInt(b.resolution.split("x")[1], 10);
			return ascending ? heightA - heightB : heightB - heightA;
		});
	}

	/**
	 * Retrieves the highest quality item from the playlist.
	 *
	 * @return {Object|null} The highest quality item from the playlist, or null if the playlist is empty.
	 */
	getHighestQuality() {
		if (this._playlist.length === 0) {
			return null;
		}
		return this._sortPlaylistByQuality(false)[0]; // Retornar o item de maior qualidade
	}

	/**
	 * Retrieves the lowest quality item from the playlist.
	 *
	 * @return {Object|null} The lowest quality item from the playlist, or null if the playlist is empty.
	 */
	getLowestQuality() {
		if (this._playlist.length === 0) {
			return null;
		}
		return this._sortPlaylistByQuality(true)[0]; // Retornar o item de menor qualidade
	}
}

module.exports = M3U8Service;
