import { z } from 'zod';

export const uuid = z.uuid();
export const displayName = z.string().normalize('NFKC').trim().min(1).max(50)
  .refine(value => !/[<>\u0000-\u001f\u007f]/u.test(value), 'Invalid name');
export const email = z.string().trim().toLowerCase().max(254).email()
  .refine(value => /^[\x21-\x7e]+$/.test(value), 'ASCII email required for SES');
export const recipient = z.strictObject({ name: displayName, email });
export const recipients = z.array(recipient).min(1).max(2).refine(values => new Set(values.map(x => x.email)).size === values.length, 'Duplicate recipients');
export const bodySchemas = {
  empty: z.strictObject({}),
  profile: z.strictObject({ display_name: displayName }),
  recipients: z.strictObject({ recipients }),
  consent: z.strictObject({ policy_version: z.string().min(1).max(50), result: z.enum(['granted', 'denied']) }),
  face: z.strictObject({ liveness_session_id: uuid }),
  confirmation: z.strictObject({ confirmed: z.boolean() }),
  safety: z.strictObject({ policy_version: z.string().min(1).max(50), consent: z.literal(true) }),
  liveness: z.strictObject({ purpose: z.enum(['enrollment', 'registration', 'safety']), enrollment_id: uuid.optional() })
    .refine(value => value.purpose !== 'enrollment' || value.enrollment_id !== undefined, 'Enrollment ID required'),
};
export const maskEmail = value => { const [local, domain] = value.split('@'); return `${local.slice(0, local.length > 2 ? 2 : 1)}•••@${domain}`; };
