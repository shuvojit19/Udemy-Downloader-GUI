"use strict";

const axios = require("axios");
const NodeCache = require("node-cache");
const M3U8Service = require("./m3u8.service");

class UdemyService {
	#timeout = 600000;
	#headerAuth = null;

	#urlBase;
	#urlLogin;
	#URL_COURSES = "/users/me/subscribed-courses";
	#URL_COURSES_ENROLL = "/users/me/subscription-course-enrollments";
	#ASSETS_FIELDS = "&fields[asset]=asset_type,title,filename,body,captions,media_sources,stream_urls,download_urls,external_url,media_license_token";

	#cache = new NodeCache({ stdTTL: 3600 }); // TTL padrão de 1 hora

	constructor(subDomain = "www", httpTimeout = 600000) {
		subDomain = (subDomain.trim().length === 0 ? "www" : subDomain.trim()).toLowerCase();

		this.#urlBase = `https://${subDomain}.udemy.com`;
		this.#timeout = httpTimeout;
		this.#headerAuth = null;
		this.#urlLogin = `${this.#urlBase}/join/login-popup`;
	}

	/**
	 * Creates and returns a new Error object with the specified name and message.
	 *
	 * @param {string} name - The name of the error.
	 * @param {string} [message=""] - The optional error message. Default is an empty string.
	 * @returns {Error} The newly created Error object.
	 */
	_error(name, message = "") {
		const error = new Error();
		error.name = name;
		error.message = message;
		return error;
	}

	async _prepareStreamSource(courseId, el) {
		try {
			if (el._class === "lecture") {
				const assetType = el.asset?.asset_type ? el.asset.asset_type.toLowerCase() : "";
				if (assetType === "video" || assetType === "videomashup") {
					const asset = el.asset;
					const stream_urls = asset?.stream_urls?.Video || asset?.media_sources;
					const isEncrypted = Boolean(asset?.media_license_token);
					if (stream_urls) {
						// console.log(`Preparing streams for asset id: ${asset.id}`);
						const streams = await this._convertToStreams(stream_urls, isEncrypted, asset?.title || "");

						if (el.asset) {
							delete el.asset.stream_urls;
							delete el.asset.media_sources;
							el.asset.streams = streams;
						}
					}
				} else if (assetType === "presentation") {
					const lecture = await this.fetchLecture(courseId, el.id, true, true);
					if (lecture) {
						el.asset = lecture.asset;
						el.supplementary_assets = lecture.supplementary_assets;
					}
				}
			}
		} catch (error) {
			throw this._error("EPREPARE_STREAM_SOURCE", error.message);
		}
	}

	async _prepareStreamsSource(courseId, items) {
		try {
			const promises = items.map((el) => this._prepareStreamSource(courseId, el));
			await Promise.allSettled(promises);
		} catch (error) {
			console.warn("Error in _prepareStreamsSource:", error);
		}
	}

	/**
	 * Transforms media sources into a standardized format.
	 *
	 * @param {Array<Object>} streamUrls - The array of stream URLs.
	 * @param {boolean} isEncrypted - Indicates if the media is encrypted.
	 * @returns {Promise<{
	 *  minQuality: string|null,
	 *  maxQuality: string|null,
	 *  isEncrypted: boolean
	 *  sources: { [key: string]: { type: string, url: string } }
	 * }>} - The transformed media sources.
	 */
	async _convertToStreams(streamUrls, isEncrypted, title = "") {
		try {
			if (!streamUrls) {
				throw this._error("ENO_STREAMS", "No streams found to convert");
			}
			const sources = {};
			let minQuality = Number.MAX_SAFE_INTEGER;
			let maxQuality = Number.MIN_SAFE_INTEGER;

			let streams = !isEncrypted ? streamUrls : streamUrls.filter((v) => !(v.file || v.src).includes("/encrypted-files"));
			isEncrypted = isEncrypted ? streams.length === 0 : isEncrypted;

			streams = streams.length > 0 ? streams : streamUrls;

			const promises = streams.map(async (video) => {
				const type = video.type;
				if (type !== "application/dash+xml") {
					const quality = video.label.toLowerCase();
					const url = video.file || video.src;

					sources[quality] = { type, url };

					if (quality !== "auto") {
						const numericQuality = parseInt(quality, 10);
						if (!isNaN(numericQuality)) {
							if (numericQuality < minQuality) {
								minQuality = numericQuality;
							}
							if (numericQuality > maxQuality) {
								maxQuality = numericQuality;
							}
						}
					} else {
						// auto
						if (!isEncrypted) {
							try {
								const m3u8 = new M3U8Service(url);
								const playlist = await m3u8.loadPlaylist();

								for (const item of playlist) {
									const numericQuality = item.quality;

									if (numericQuality < minQuality) {
										minQuality = numericQuality;
									}
									if (numericQuality > maxQuality) {
										maxQuality = numericQuality;
									}
									if (!sources[numericQuality.toString()]) {
										sources[numericQuality.toString()] = { type, url: item.url };
									}
								}
							} catch (m3u8Err) {
								console.warn(`[m3u8.loadPlaylist] Could not parse auto playlist for ${title}:`, m3u8Err.message);
								if (!sources["auto"]) {
									sources["auto"] = { type, url };
								}
							}
						}
					}
				}
			});

			await Promise.allSettled(promises);

			return {
				minQuality: minQuality === Number.MAX_SAFE_INTEGER ? (sources["auto"] ? "auto" : null) : minQuality.toString(),
				maxQuality: maxQuality === Number.MIN_SAFE_INTEGER ? (sources["auto"] ? "auto" : null) : maxQuality.toString(),
				isEncrypted,
				sources,
			};
		} catch (error) {
			throw this._error("ECONVERT_TO_STREAMS", error.message);
		}
	}

	async #fetchUrl(url, method = "GET", httpTimeout = this.#timeout, retries = 5) {
		// Verifique o cache antes de fazer a requisição
		const cachedData = this.#cache.get(url);
		if (cachedData) {
			// console.log(`Cache hit: ${url}`);
			return cachedData;
		}

		console.log(`Fetching URL: ${url}`);
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				const response = await axios({
					url,
					method,
					headers: this.#headerAuth,
					timeout: httpTimeout || this.#timeout,
				});

				// Armazene o resultado no cache
				this.#cache.set(url, response.data);
				return response.data;
			} catch (e) {
				const status = e?.response?.status;
				const isRetryable = !status || status >= 500 || status === 429 || e.code === "ETIMEDOUT" || e.code === "ECONNRESET";

				if (isRetryable && attempt < retries) {
					const delay = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
					console.warn(`[#fetchUrl] Attempt ${attempt}/${retries} failed for ${url} (status: ${status || e.code}). Retrying in ${delay}ms...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					console.error(`Error fetching URL: ${url}`, e);
					throw e;
				}
			}
		}
	}

	async #fetchEndpoint(endpoint, method = "GET", httpTimeout = this.#timeout) {
		endpoint = `${this.#urlBase}/api-2.0${endpoint}`;
		return await this.#fetchUrl(endpoint, method, httpTimeout);
	}

	async fetchLoadMore(url, httpTimeout = this.#timeout, retries = 5) {
		// Verifique o cache antes de fazer a requisição
		const cachedData = this.#cache.get(url);
		if (cachedData) {
			// console.log(`Cache hit: ${url}`);
			return cachedData;
		}

		// console.log(`Fetching URL: ${url}`);
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				const response = await axios({
					url,
					method: "GET",
					headers: this.#headerAuth,
					timeout: httpTimeout || this.#timeout,
				});

				// Armazene o resultado no cache
				this.#cache.set(url, response.data);
				return response.data;
			} catch (e) {
				const status = e?.response?.status;
				const isRetryable = !status || status >= 500 || status === 429 || e.code === "ETIMEDOUT" || e.code === "ECONNRESET";

				if (isRetryable && attempt < retries) {
					const delay = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
					console.warn(`[fetchLoadMore] Attempt ${attempt}/${retries} failed for ${url} (status: ${status || e.code}). Retrying in ${delay}ms...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					console.error(`Error fetching URL: ${url}`, e);
					throw e;
				}
			}
		}
	}

	async fetchProfile(accessToken, httpTimeout = this.#timeout) {
		this.#headerAuth = { Authorization: `Bearer ${accessToken}` };
		return await this.#fetchEndpoint("/contexts/me/?header=True");
	}



	async fetchSearchCourses(keyword, pageSize, isSubscriber, httpTimeout = this.#timeout) {
		if (!keyword) {
			return await this.fetchCourses(pageSize, isSubscriber, httpTimeout);
		}

		pageSize = Math.max(pageSize, 10);

		const param = `page=1&ordering=title&fields[user]=job_title&page_size=${pageSize}&search=${keyword}`;
		// const url = !isSubscriber ? `${this.#URL_COURSES}?${param}` : `${this.#URL_COURSES_ENROLL}?${param}`;
		const url = `${this.#URL_COURSES}?${param}`;
		const urlEnroll = `${this.#URL_COURSES_ENROLL}?${param}`;

		if (isSubscriber) {
			const [courses, enrolledCourses] = await Promise.all([
				this.#fetchEndpoint(url, "GET", httpTimeout),
				this.#fetchEndpoint(urlEnroll, "GET", httpTimeout),
			]);

			const next = [courses.next, enrolledCourses.next].filter((n) => n !== null);
			const previous = [courses.previous, enrolledCourses.previous].filter((p) => p !== null);

			return {
				count: courses.count + enrolledCourses.count,
				next: next.length > 0 ? next : null,
				previous: previous.length > 0 ? previous : null,
				results: [...courses.results, ...enrolledCourses.results],
			};
		}

		return await this.#fetchEndpoint(url, "GET", httpTimeout);
	}

	async fetchCourses(pageSize = 30, isSubscriber = false, httpTimeout = this.#timeout) {
		pageSize = Math.max(pageSize, 10);

		const param = `page_size=${pageSize}&ordering=-last_accessed`;
		// const url = !isSubscriber ? `${this.#URL_COURSES}?${param}` : `${this.#URL_COURSES_ENROLL}?${param}`;
        const url = `${this.#URL_COURSES}?${param}`;
        const urlEnroll = `${this.#URL_COURSES_ENROLL}?${param}`;

        if (isSubscriber) {
            const [courses, enrolledCourses] = await Promise.all([
                this.#fetchEndpoint(url, "GET", httpTimeout),
                this.#fetchEndpoint(urlEnroll, "GET", httpTimeout)
            ]);

            const next = [courses.next, enrolledCourses.next].filter((n) => n !== null);
            const previous = [courses.previous, enrolledCourses.previous].filter((p) => p !== null);

            return {
                count: courses.count + enrolledCourses.count,
                next: next.length > 0 ? next : null,
                previous: previous.length > 0 ? previous : null,
                results: [...courses.results, ...enrolledCourses.results]
            }
        }

		return await this.#fetchEndpoint(url, "GET", httpTimeout);
	}

	async fetchCourse(courseId, httpTimeout = this.#timeout) {
		const url = `/courses/${courseId}/cached-subscriber-curriculum-items?page_size=10000&fields[lecture]=id,title,asset`;
		return await this.#fetchEndpoint(url, "GET", httpTimeout);
	}

	/**
	 * Fetches the lecture data for a given course and lecture ID.
	 *
	 * @param {number} courseId - The ID of the course.
	 * @param {number} lectureId - The ID of the lecture.
	 * @param {boolean} getAttachments - Whether to get supplementary assets. Defaults to false.
	 * @return {Promise<any>} - The lecture data.
	 */
	async fetchLecture(courseId, lectureId, getAttachments, allAssets = false, httpTimeout = this.#timeout) {
		let url = `/users/me/subscribed-courses/${courseId}/lectures/${lectureId}?fields[lecture]=id,title,asset${getAttachments ? ",supplementary_assets" : ""}`;
		url += allAssets ? "&fields[asset]=@all" : this.#ASSETS_FIELDS;

		const lectureData = await this.#fetchEndpoint(`${url}`, "GET", httpTimeout);
		// console.log("fetchLecture", lectureData);
		// await this._prepareStreamSource(lectureData);

		return lectureData;
	}

	async fetchLectureAttachments(lectureId, httpTimeout = this.#timeout) {
		const url = `/lectures/${lectureId}/supplementary-assets`;
		return await this.#fetchEndpoint(url);
	}

	/**
	 * Fetches the course content for a given course ID and content type.
	 *
	 * @param {number} courseId - The ID of the course.
	 * @param {'less' | 'all' | 'lectures' | 'attachments'} [contentType='all'] - The type of content to fetch.
	 * @return {Promise<any>} - The course content data.
	 */
	async fetchCourseContent(courseId, contentType, httpTimeout = this.#timeout) {
		let url = `${this.#urlBase}/api-2.0/courses/${courseId}/cached-subscriber-curriculum-items?page_size=200`;

		contentType = (contentType || "less").toLowerCase();
		if (contentType !== "less") url += "&fields[lecture]=id,title";
		if (contentType === "all") url += ",asset,supplementary_assets";
		if (contentType === "lectures") url += ",asset";
		if (contentType === "attachments") url += ",supplementary_assets";
		if (contentType !== "less") url += this.#ASSETS_FIELDS;

		let contentData = null;
		let loadContent = false;

		try {
			// contentData = await this.#fetchEndpoint(url);
			do {
				const resp = await this.#fetchUrl(url);
				if (!contentData) {
					contentData = resp;
				} else {
					contentData.results.push(...resp.results);
				}

				if (resp.next) {
					url = decodeURI(resp.next);
					url = url.replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",");
				}

				loadContent = resp.next != null;
			} while (loadContent);

			loadContent = false;
		} catch (error) {
			const status = error?.response?.status;
			if (status === 503 || status === 504 || status === 502 || status === 500) {
				console.warn(`[fetchCourseContent] Primary endpoint failed with status ${status}. Switching to fallback fetchCourse...`);
				contentData = await this.fetchCourse(courseId, httpTimeout);
				loadContent = contentType !== "less";
			} else {
				throw error;
			}
		}

		if (!contentData || contentData.count == 0) {
			return null;
		}

		if (contentData.results[0]._class !== "chapter") {
			contentData.results.unshift({
				id: 0,
				_class: "chapter",
				title: "Chapter 1",
			});
			contentData.count++;
		}

		if (loadContent) {
			const promises = contentData.results.map(async (el) => {
				if (el._class === "lecture") {
					const lecture = await this.fetchLecture(courseId, el.id, true, false, httpTimeout);
					el.asset = lecture.asset;
					el.supplementary_assets = lecture.supplementary_assets;
				}
				return el;
			});
			await Promise.all(promises);
		}

		contentData.count = contentData.results.length;

		await this._prepareStreamsSource(courseId, contentData.results);
		// console.log("fetchCourseContent", contentData);
		return contentData;
	}

	get urlBase() {
		return this.#urlBase;
	}
	get urlLogin() {
		return this.#urlLogin;
	}

	get timeout() {
		return this.#timeout;
	}
	set timeout(value) {
		this.#timeout = value;
	}
}

module.exports = UdemyService;
