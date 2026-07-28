interface Env {
  ENABLED: string;
  ANTHROPIC_API_KEY?: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    if (env.ENABLED !== "true") {
      return Response.json(
        {
          code: "RESOURCE_UNAVAILABLE",
          message: "The optional conflict advisor is disabled.",
          retryable: false
        },
        { status: 503 }
      );
    }
    return Response.json(
      {
        code: "RESOURCE_UNAVAILABLE",
        message: "No conflict advisor implementation is configured.",
        retryable: false
      },
      { status: 503 }
    );
  }
} satisfies ExportedHandler<Env>;
