declare module "mathjax" {
  interface MathJaxRuntime {
    tex2svgPromise(input: string, options: { display: boolean }): Promise<unknown>;
    startup: {
      adaptor: {
        serializeXML(node: unknown): string;
      };
    };
  }

  const MathJax: {
    init(config: Record<string, unknown>): Promise<MathJaxRuntime | undefined>;
  };

  export default MathJax;
}
