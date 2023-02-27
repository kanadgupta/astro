import MagicString from 'magic-string';
import mime from 'mime';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as vite from 'vite';
import type { AstroPluginOptions } from '../@types/astro';
import { VIRTUAL_MODULE_ID, VIRTUAL_SERVICE_ID } from './consts.js';
import { isLocalService } from './services/service.js';
import { imageMetadata } from './utils/metadata.js';
import { getOrigQueryParams } from './utils/queryParams.js';

const resolvedVirtualModuleId = '\0' + VIRTUAL_MODULE_ID;

export default function assets({ settings, logging }: AstroPluginOptions): vite.Plugin[] {
	let resolvedConfig: vite.ResolvedConfig;

	return [
		// Expose the components and different utilities from `astro:assets` and handle serving images from `/_image` in dev
		{
			name: 'astro:assets',
			async resolveId(id) {
				if (id === VIRTUAL_SERVICE_ID) {
					return await this.resolve(settings.config.image.service);
				}
				if (id === VIRTUAL_MODULE_ID) {
					return resolvedVirtualModuleId;
				}
			},
			load(id) {
				if (id === resolvedVirtualModuleId) {
					return `
					export { getImage, getConfiguredService } from "astro/assets";
					export { default as Image } from "astro/components/Image.astro";
				`;
				}
			},
			// Handle serving images during development
			configureServer(server) {
				server.middlewares.use(async (req, res, next) => {
					if (req.url?.startsWith('/_image')) {
						// If the currently configured service isn't a local service, we don't need to do anything here.
						// TODO: Support setting a specific service through a prop on Image / a parameter in getImage
						if (!isLocalService(globalThis.astroImageService)) {
							return next();
						}

						const url = new URL(req.url, 'file:');
						const filePath = url.searchParams.get('href');

						if (!filePath) {
							return next();
						}

						const filePathURL = new URL(filePath, 'file:');
						const file = await fs.readFile(filePathURL.pathname);

						// Get the file's metadata from the URL
						let meta = getOrigQueryParams(filePathURL.searchParams);

						// If we don't have them (ex: the image came from Markdown, let's calculate them again)
						if (!meta) {
							meta = await imageMetadata(filePathURL, file);

							if (!meta) {
								return next();
							}
						}

						const transform = await globalThis.astroImageService.parseURL(url);

						// if no transforms were added, the original file will be returned as-is
						let data = file;
						let format = meta.format;

						if (transform) {
							const result = await globalThis.astroImageService.transform(file, transform);
							data = result.data;
							format = result.format;
						}

						res.setHeader('Content-Type', mime.getType(fileURLToPath(url)) || `image/${format}`);
						res.setHeader('Cache-Control', 'max-age=360000');

						const stream = Readable.from(data);
						return stream.pipe(res);
					}

					return next();
				});
			},
			// In build, rewrite paths to ESM imported images in code to their final location
			async renderChunk(code) {
				const assetUrlRE = /__ASTRO_ASSET_IMAGE__([a-z\d]{8})__(?:_(.*?)__)?/g;

				let match;
				let s;
				while ((match = assetUrlRE.exec(code))) {
					s = s || (s = new MagicString(code));
					const [full, hash, postfix = ''] = match;

					const file = this.getFileName(hash);
					const outputFilepath = resolvedConfig.base + file + postfix;

					s.overwrite(match.index, match.index + full.length, outputFilepath);
				}

				if (s) {
					return {
						code: s.toString(),
						map: resolvedConfig.build.sourcemap ? s.generateMap({ hires: true }) : null,
					};
				} else {
					return null;
				}
			},
		},
		// Return a more advanced shape for images imported in ESM
		{
			name: 'astro:assets:esm',
			enforce: 'pre',
			configResolved(viteConfig) {
				resolvedConfig = viteConfig;
			},
			async load(id) {
				if (/\.(heic|heif|avif|jpeg|jpg|png|tiff|webp|gif)$/.test(id)) {
					const url = pathToFileURL(id);
					const meta = await imageMetadata(url);

					if (!meta) {
						return;
					}

					if (!this.meta.watchMode) {
						const pathname = decodeURI(url.pathname);
						const filename = path.basename(pathname, path.extname(pathname) + `.${meta.format}`);

						const handle = this.emitFile({
							name: filename,
							source: await fs.readFile(url),
							type: 'asset',
						});

						meta.src = `__ASTRO_ASSET_IMAGE__${handle}__`;
					} else {
						// Pass the original file information through query params so we don't have to load the file twice
						url.searchParams.append('origWidth', meta.width.toString());
						url.searchParams.append('origHeight', meta.height.toString());
						url.searchParams.append('origFormat', meta.format);

						meta.src = url.toString();
					}

					return `export default ${JSON.stringify(meta)}`;
				}
			},
		},
	];
}