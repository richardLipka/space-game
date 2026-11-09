import { describe, expect, it } from "vitest";
import { keyName } from "../../src/ui/input";

const k = (code: string, key: string, shiftKey = false) => keyName({ code, key, shiftKey });

describe("layout-independent keys", () => {
  it("the row above the letters selects groups on any layout (Czech: + ě š …)", () => {
    expect(k("Digit1", "+")).toBe("digit1");
    expect(k("Digit2", "ě")).toBe("digit2");
    expect(k("Digit9", "í")).toBe("digit9");
    expect(k("Digit1", "1")).toBe("digit1");
    expect(k("Numpad3", "3")).toBe("digit3");
  });

  it("a Czech '+' on the digit row never changes the time scale; the time-scale keys are by position", () => {
    expect(k("Digit1", "+")).not.toBe("+");
    expect(k("Equal", "´")).toBe("+");
    expect(k("NumpadAdd", "+")).toBe("+");
    expect(k("Minus", "=")).toBe("-");
    expect(k("BracketRight", ")")).toBe("+");
    expect(k("BracketLeft", "ú")).toBe("-");
  });

  it("letters by position (QWERTZ, AZERTY), other keys by name; synthetic events without a code still work", () => {
    expect(k("KeyW", "w")).toBe("w");
    expect(k("KeyQ", "a")).toBe("q"); // AZERTY: the key in the Q position
    expect(k("KeyY", "z")).toBe("y"); // QWERTZ
    expect(k("Space", " ")).toBe(" ");
    expect(k("Tab", "Tab")).toBe("tab");
    expect(k("Escape", "Escape")).toBe("escape");
    expect(k("", "m")).toBe("m");
    expect(k("", "2")).toBe("digit2");
  });
});
