import { z } from "zod";

export const NativeIdSchema = z.union([z.string().min(1), z.number().int()]);

export const NativeRequestSchema = z
  .object({
    id: NativeIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
    trace: z
      .object({
        traceId: z.string().min(1).optional(),
        parentId: z.string().min(1).optional(),
        spanId: z.string().min(1).optional(),
        traceparent: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const NativeNotificationSchema = z
  .object({
    method: z.string().min(1),
    params: z.unknown().optional(),
    trace: z
      .object({
        traceId: z.string().min(1).optional(),
        parentId: z.string().min(1).optional(),
        spanId: z.string().min(1).optional(),
        traceparent: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const NativeSuccessResponseSchema = z
  .object({ id: NativeIdSchema, result: z.unknown() })
  .strict();

export const NativeErrorResponseSchema = z
  .object({
    id: NativeIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1),
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

export const NativeEnvelopeSchema = z.union([
  NativeRequestSchema,
  NativeNotificationSchema,
  NativeSuccessResponseSchema,
  NativeErrorResponseSchema,
]);

export type NativeRequest = z.infer<typeof NativeRequestSchema>;
export type NativeNotification = z.infer<typeof NativeNotificationSchema>;
export type NativeSuccessResponse = z.infer<typeof NativeSuccessResponseSchema>;
export type NativeErrorResponse = z.infer<typeof NativeErrorResponseSchema>;
export type NativeEnvelope = z.infer<typeof NativeEnvelopeSchema>;
