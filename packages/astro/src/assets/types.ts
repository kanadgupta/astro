import { VALID_INPUT_FORMATS, VALID_OUTPUT_FORMATS } from './consts.js';

type ImageQualityPreset = 'low' | 'mid' | 'high' | 'max';
export type ImageQuality = ImageQualityPreset | number;

// eslint-disable-next-line @typescript-eslint/ban-types
export type InputFormat = (typeof VALID_INPUT_FORMATS)[number] | (string & {});
// eslint-disable-next-line @typescript-eslint/ban-types
export type OutputFormat = (typeof VALID_OUTPUT_FORMATS)[number] | (string & {});

/**
 * Type returned by ESM imports of images and direct calls to imageMetadata
 */
export interface ImageMetadata {
	src: string;
	width: number;
	height: number;
	format: InputFormat;
}

/**
 * All the transformations possible to an image
 */
export type ImageTransform = {
	src: ImageMetadata | string;
	width?: number;
	height?: number;
	quality?: ImageQuality;
	format?: OutputFormat;
	[key: string]: any;
};

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
type ImageSharedProps<T> = T & {
	/**
	 * Width of the image, the value of this property will be used to assign the `width` property on the final `img` element.
	 *
	 * For local images, this value will additionally be used to resize the image to the desired width, taking into account the original aspect ratio of the image.
	 *
	 * **Example**:
	 * ```astro
	 * <Image src={...} width={300} alt="..." />
	 * ```
	 * **Result**:
	 * ```html
	 * <img src="..." width="300" height="..." alt="..." />
	 * ```
	 */
	width?: number | `${number}`;
	height?: number | `${number}`;
};

export type LocalImageProps<T> = ImageSharedProps<T> & {
	/**
	 * A reference to a local image imported through an ESM import.
	 *
	 * **Example**:
	 * ```js
	 * import myImage from "~/assets/my_image.png";
	 * ```
	 * And then refer to the image, like so:
	 * ```astro
	 *	<Image src={myImage} alt="..."></Image>
	 * ```
	 */
	src: ImageMetadata;
	/**
	 * Desired output format for the image. Defaults to `webp`.
	 *
	 * **Example**:
	 * ```astro
	 * <Image src={...} format="avif" alt="..." />
	 * ```
	 */
	format?: OutputFormat;
	/**
	 * Desired quality for the image. Value can either be a preset such as `low` or `high`, or a numeric value from 0 to 100.
	 *
	 * Ultimately, the ending perceivable quality is loader-specific.
	 * For instance, a certain service might decide that `high` results in a very beautiful image, but another could choose for it to be at best passable.
	 *
	 * **Example**:
	 * ```astro
	 * <Image src={...} quality='high' alt="..." />
	 * <Image src={...} quality={300} alt="..." />
	 * ```
	 */
	quality?: ImageQuality;
};

export type RemoteImageProps<T> = WithRequired<ImageSharedProps<T>, 'width' | 'height'> & {
	/**
	 * URL of a remote image. Can start with a protocol (ex: `https://`) or alternatively `/`, or `Astro.url`, for images in the `public` folder
	 *
	 * Remote images are not optimized, and require both `width` and `height` to be set.
	 *
	 * **Example**:
	 * ```
	 * <Image src="https://example.com/image.png" width={450} height={300} alt="..." />
	 * ```
	 */
	src: string;
};