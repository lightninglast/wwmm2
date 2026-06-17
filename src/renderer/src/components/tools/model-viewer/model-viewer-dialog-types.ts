import type {
    ModelViewerAnimationClip,
    ModelViewerRealtimeShapeKey,
} from "./model-viewer-contract";

export type VariableStateValue = number | string;

export type ModelRotationAction = {
    label: string;
    delta: [number, number, number];
};

export const DEFAULT_MODEL_ORIENTATION = "0deg 0deg 0deg";
export const DEFAULT_THREE_EXPOSURE = 0.7;
export const MIN_THREE_EXPOSURE = 0;
export const MAX_THREE_EXPOSURE = 4;

export const MODEL_ROTATION_ACTIONS: ModelRotationAction[] = [
    { label: "Left 90°", delta: [0, 0, -90] },
    { label: "Right 90°", delta: [0, 0, 90] },
    { label: "Up 90°", delta: [0, -90, 0] },
    { label: "Down 90°", delta: [0, 90, 0] },
    { label: "Flip 180°", delta: [0, 0, 180] },
];

export type ModelViewerVariantManifest = {
    iniPath: string;
    defaultState: Record<string, VariableStateValue>;
    variables: Array<{
        id: string;
        label: string;
        defaultValue: VariableStateValue;
        values: Array<{ value: VariableStateValue; label: string }>;
        order: number;
        slot?: number;
        iconPath?: string;
        controlType?: "buttons" | "slider";
        slider?: {
            min: number;
            max: number;
            step: number;
        };
    }>;
    uiAssets: {
        backgroundPath?: string;
        slotPath?: string;
        slotHoverPath?: string;
        slotActivePath?: string;
    };
    shapeKeys?: ModelViewerRealtimeShapeKey[];
    animations?: ModelViewerAnimationClip[];
    states: Array<{
        key: string;
        values: Record<string, VariableStateValue>;
        glbPath: string;
    }>;
};

export type ModelViewerWwmiComponent = {
    index: number;
    meshName: string;
    vertexCount: number;
    selectedResourceName?: string;
    selectedHash?: string;
    candidates: Array<{ resourceName: string; filename: string; hash?: string }>;
};

export type WwmiTextureConflict = {
    componentIndex: number;
    chosenHash: string;
    existingHash: string;
    sourceMod: string;
    sourceSize?: number;
    newSize: number;
};

export type WwmiConflictResolution = "use-new" | "keep-old" | "keep-both";

export type ModelViewerDialogSource =
    | {
          mode: "single";
          glbPath: string;
          memorySessionId?: string;
          modPath?: string;
          name: string;
          wwmiComponents?: ModelViewerWwmiComponent[];
      }
    | {
          mode: "variant-set";
          artifactRoot: string;
          manifestPath: string;
          modPath: string;
          manifest: ModelViewerVariantManifest;
          memorySessionId?: string;
          defaultGlbPath: string;
          activeGlbPath: string;
          name: string;
          wwmiComponents?: ModelViewerWwmiComponent[];
      };
