// React context for demo mode. Bridges the framework-free state module
// (./state) into the component tree so UI can read `isDemo` reactively
// and flip it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { isDemoActive, reloadIntoMode, subscribeDemo } from "./state";

interface DemoModeContextValue {
  isDemo: boolean;
  /** Turn demo on and reload into the sandbox. */
  enterDemo: () => void;
  /** Turn demo off and reload into the live site. */
  exitDemo: () => void;
}

const DemoModeContext = createContext<DemoModeContextValue>({
  isDemo: false,
  enterDemo: () => {},
  exitDemo: () => {},
});

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [isDemo, setIsDemo] = useState<boolean>(() => isDemoActive());

  useEffect(() => subscribeDemo(setIsDemo), []);

  const enterDemo = useCallback(() => reloadIntoMode(true), []);
  const exitDemo = useCallback(() => reloadIntoMode(false), []);

  return (
    <DemoModeContext.Provider value={{ isDemo, enterDemo, exitDemo }}>
      {children}
    </DemoModeContext.Provider>
  );
}

export function useDemoMode(): DemoModeContextValue {
  return useContext(DemoModeContext);
}
