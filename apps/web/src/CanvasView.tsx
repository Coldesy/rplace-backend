import { useEffect, useRef } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH, PALETTE, X_MIN, Y_MIN } from "@rplace/shared";

const SCALE = 5;

type Props = {
  pixels: number[];
  selectedColor: number;
  canPlace: boolean;
  onPlace: (x: number, y: number) => void;
};

export function CanvasView({ pixels, selectedColor, canPlace, onPlace }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const image = ctx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
    for (let i = 0; i < pixels.length; i += 1) {
      const hex = PALETTE[pixels[i] ?? 0] ?? PALETTE[0];
      const r = Number.parseInt(hex.slice(1, 3), 16);
      const g = Number.parseInt(hex.slice(3, 5), 16);
      const b = Number.parseInt(hex.slice(5, 7), 16);
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
      image.data[i * 4 + 3] = 255;
    }
    const offscreen = document.createElement("canvas");
    offscreen.width = CANVAS_WIDTH;
    offscreen.height = CANVAS_HEIGHT;
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) {
      return;
    }
    offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  }, [pixels]);

  return (
    <canvas
      ref={canvasRef}
      className={canPlace ? "board" : "board board-readonly"}
      width={CANVAS_WIDTH * SCALE}
      height={CANVAS_HEIGHT * SCALE}
      onClick={(event) => {
        if (!canPlace) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const px = Math.floor((event.clientX - rect.left) / SCALE);
        const py = Math.floor((event.clientY - rect.top) / SCALE);
        onPlace(px + X_MIN, py + Y_MIN);
      }}
      title={canPlace ? `placing color ${selectedColor}` : "read-only viewer"}
    />
  );
}
