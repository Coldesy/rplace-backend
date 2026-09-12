import { useEffect, useState } from "react";
import { PALETTE, type UserView } from "@rplace/shared";
import { CanvasView } from "./CanvasView";
import { useCanvasSocket } from "./useCanvasSocket";

const USER_KEY = "rplace:mock_user_id";

export function App() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [mockUserId, setMockUserId] = useState<string | undefined>(() => {
    return sessionStorage.getItem(USER_KEY) ?? undefined;
  });
  const [colorIndex, setColorIndex] = useState(5);
  const { pixels, seq, you, status, lastError, place } = useCanvasSocket(mockUserId);

  useEffect(() => {
    void fetch("/mock-users")
      .then((response) => response.json())
      .then((data: UserView[]) => setUsers(data));
  }, []);

  const canPlace = Boolean(you && !you.banned);

  return (
    <div className="app">
      <header>
        <h1>Pixel canvas prototype</h1>
        <p>
          {status} · seq {seq}
          {you ? ` · ${you.display_name}` : " · viewer"}
        </p>
        {lastError ? <p className="error">{lastError}</p> : null}
      </header>
      <section className="controls">
        <label>
          Mock user
          <select
            value={mockUserId ?? ""}
            onChange={(event) => {
              const value = event.target.value || undefined;
              setMockUserId(value);
              if (value) {
                sessionStorage.setItem(USER_KEY, value);
              } else {
                sessionStorage.removeItem(USER_KEY);
              }
            }}
          >
            <option value="">viewer (read only)</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.display_name}
              </option>
            ))}
          </select>
        </label>
        <div className="palette" role="listbox" aria-label="palette">
          {PALETTE.map((hex, index) => (
            <button
              key={hex}
              type="button"
              className={index === colorIndex ? "swatch selected" : "swatch"}
              style={{ background: hex }}
              onClick={() => setColorIndex(index)}
              aria-label={`color ${index}`}
            />
          ))}
        </div>
      </section>
      <CanvasView
        pixels={pixels}
        selectedColor={colorIndex}
        canPlace={canPlace}
        onPlace={(x, y) => place(x, y, colorIndex)}
      />
      <p className="hint">Local prototype only. Click the canvas to place a pixel over WebSocket.</p>
    </div>
  );
}
