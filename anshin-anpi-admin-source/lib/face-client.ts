import { faceApi } from './face-api';

export type FaceMetrics = {
  face_confidence?: number | null;
  brightness?: number | null;
  sharpness?: number | null;
  similarity_score?: number | null;
  match_threshold?: number;
  liveness_passed: boolean;
  liveness_score?: number | null;
};
export type UserSession = { user_token: string; expires_at: string; user_id?: string };
export type RecipientResult = { delivery_id: string; recipient_id: string; status: string; error_code?: string | null };
export type MailResult = {
  check_id: string; type: 'registration' | 'safety'; mail_status: string;
  user_id: string; user_status: string; registration_completed: boolean;
  recipient_results: RecipientResult[];
};
export type FaceResult = {
  result: 'matched' | 'no_match' | 'ambiguous';
  metrics: FaceMetrics;
  display_name?: string;
  user_token?: string;
  expires_at?: string;
  attempts_remaining?: number;
  matched?: boolean;
  user_id?: string;
  user_status?: string;
  verification_status?: string;
  similarity_score?: number | null;
  check_id?: string;
  mail_status?: string;
  recipient_results?: RecipientResult[];
  registration_completed?: boolean;
};
export type RegistrationInput = {
  displayName: string;
  policyVersion: string;
  recipients: Array<{ name: string; email: string }>;
  imageBase64: string;
};

/** Browser client: baseUrl points to the frontend's BFF, never includes terminal secrets. */
export function createFaceClient(baseUrl = '/api/terminal') {
  const call = <T>(path: string, method = 'GET', body?: unknown, userToken?: string, idempotencyKey?: string) =>
    faceApi<T>(path, method, body, userToken, { baseUrl, idempotencyKey });
  return {
    captureRegistration: (imageBase64: string, key?: string) =>
      call<{ temp_id: string; face_valid: boolean; expires_at: string; idle_timeout_seconds: number; metrics: FaceMetrics }>(
        '/registrations/capture', 'POST', { image_base64: imageBase64 }, undefined, key),
    register: (body: { temp_id: string; display_name: string; recipients: RegistrationInput['recipients'];
      policy_version: string; consent_result: 'granted' | 'denied' }, key?: string) =>
      call<{ success: boolean; user_id: string | null; user_status: 'pending_registration' | null;
        registration_completed: false; user_token?: string; expires_at?: string }>('/registrations', 'POST', body, undefined, key),
    verifyAndNotify: (imageBase64: string, userId: string, userToken: string, key?: string) =>
      call<FaceResult>('/registrations/verify', 'POST', { image_base64: imageBase64, user_id: userId }, userToken, key),
    confirmRecipients: (userId: string, confirmed: boolean, userToken: string, key?: string) =>
      call<{ success: boolean; confirmed: boolean; recipients: Array<{ recipient_id: string; name: string; masked_email: string; status: string }>;
        policy_version?: string; consent_body?: string; session_ended?: boolean }>(`/users/${userId}/recipients`, 'POST', { confirmed }, userToken, key),
    notifySafety: (userId: string, consent: boolean, policyVersion: string, userToken: string, key?: string) =>
      call<{ check_id: string | null; mail_status: string; recipient_results: RecipientResult[]; session_ended?: boolean }>(
        '/safety-notifications', 'POST', { user_id: userId, consent, policy_version: policyVersion }, userToken, key),
    mailResult: (checkId: string, userToken: string) => call<MailResult>(`/mail-results/${checkId}`, 'GET', undefined, userToken),
    retryMail: (checkId: string, userToken: string, key?: string) => call(`/mail-results/${checkId}/retry`, 'POST', {}, userToken, key),
    cancelRegistration: (tempId: string, key?: string) => call(`/registrations/${tempId}`, 'DELETE', {}, undefined, key),
    terminal: () => call<{ capabilities: { face: boolean; mail: boolean }; idle_timeout_seconds: number }>('/terminal'),
    registrationPolicy: () => call<{ policy_version: string; title: string; body: string }>('/consent-policies?type=registration'),
    createDraft: (key?: string) => call<{ temp_id: string; expires_at: string }>('/enrollments', 'POST', {}, undefined, key),
    setProfile: (id: string, displayName: string, key?: string) =>
      call(`/enrollments/${id}/profile`, 'PATCH', { display_name: displayName }, undefined, key),
    consent: (id: string, policyVersion: string, key?: string) =>
      call(`/enrollments/${id}/consent`, 'POST', { policy_version: policyVersion, result: 'granted' }, undefined, key),
    setRecipients: (id: string, recipients: RegistrationInput['recipients'], key?: string) =>
      call(`/enrollments/${id}/recipients`, 'PUT', { recipients }, undefined, key),
    uploadFace: (id: string, imageBase64: string, key?: string) =>
      call<{ metrics: FaceMetrics }>(`/enrollments/${id}/face`, 'POST', { image_base64: imageBase64 }, undefined, key),
    complete: (id: string, key?: string) =>
      call<UserSession & { user_id: string; status: 'pending_registration' }>(`/enrollments/${id}/complete`, 'POST', {}, undefined, key),
    verifyRegistration: (imageBase64: string, userToken: string, key?: string) =>
      call<FaceResult>('/faces/verify-registration', 'POST', { image_base64: imageBase64 }, userToken, key),
    identify: (imageBase64: string, key?: string) =>
      call<FaceResult>('/faces/identify', 'POST', { image_base64: imageBase64 }, undefined, key),
    cancelDraft: (id: string, key?: string) => call(`/enrollments/${id}`, 'DELETE', {}, undefined, key),
    endSession: (userToken: string, key?: string) => call('/sessions/current', 'DELETE', {}, userToken, key),
  };
}
