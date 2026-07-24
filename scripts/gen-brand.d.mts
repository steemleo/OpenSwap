export declare const otto: {
  name: string;
  grid: string[];
  palette: Record<string, string>;
  legend: Record<string, string>;
};
export declare function ottoRects(indent?: string): string;
export declare function ottoSvg(): string;
export declare function ottoAnsi(): string;
export declare function ottoPng(size: number): Buffer;
export declare function generate(): string[];
