export const MIN_CANVAS_DIMENSION = 10;
export const MAX_CANVAS_DIMENSION = 10000;
export const DEFAULT_CANVAS_WIDTH = 1000;
export const DEFAULT_CANVAS_HEIGHT = 600;

export const parseDimension = (value: string | undefined, fallback: number): number => {
	if (value === undefined || value === null || typeof value !== 'string' || value.trim() === '') {
		return fallback;
	}
	const dimension = Number(value);
	if (!Number.isInteger(dimension)) {
		return fallback;
	}
	if (dimension < MIN_CANVAS_DIMENSION || dimension > MAX_CANVAS_DIMENSION) {
		return fallback;
	}
	return dimension;
};

export const calculateCanvasBytes = (width: number, height: number): number => {
	return Math.ceil((width * height) / 2);
};

export const CANVAS_WIDTH = parseDimension(process.env.CANVAS_WIDTH, DEFAULT_CANVAS_WIDTH);
export const CANVAS_HEIGHT = parseDimension(process.env.CANVAS_HEIGHT, DEFAULT_CANVAS_HEIGHT);
export const CANVAS_BYTES = calculateCanvasBytes(CANVAS_WIDTH, CANVAS_HEIGHT);
