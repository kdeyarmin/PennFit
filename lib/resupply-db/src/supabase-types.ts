// Hand-authored Supabase Database type for the Drizzle → Supabase
// migration in progress.
//
// Why hand-authored: `mcp__supabase__generate_typescript_types` only
// emits the schemas exposed via PostgREST's `db_schemas` setting.
// The PennPaps Supabase project currently exposes only `public`, but
// every resupply table lives under `resupply` or `resupply_auth`. Until
// those schemas are added to the project's Exposed schemas list (Studio
// → Project Settings → API → "Exposed schemas") this file is the
// authoritative type source for the Supabase JS client.
//
// Coverage today: the tables touched by `artifacts/resupply-api/src/
// routes/storefront/admin-users.ts` (the first module ported off
// Drizzle). Extend as more modules migrate.
//
// When the `resupply` and `resupply_auth` schemas are exposed, replace
// this file with the generator output and delete the hand-authored
// shapes.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  // PostgREST default schema. Storefront-funnel tables (orders,
  // usage_events, admin_audit_log, reminder_subscriptions from
  // migration 0027) live here.
  public: {
    Tables: {
      usage_events: {
        Row: {
          id: string;
          session_id: string;
          step: string;
          metadata: string | null;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          step: string;
          metadata?: string | null;
          occurred_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["usage_events"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
  resupply: {
    Tables: {
      admin_users: {
        Row: {
          id: string;
          email_lower: string;
          role: "admin" | "agent";
          status: "pending" | "active" | "revoked";
          display_name: string | null;
          notes: string | null;
          invited_by: string | null;
          invited_at: string;
          accepted_at: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          last_login_at: string | null;
          auth_user_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_lower: string;
          role?: "admin" | "agent";
          status?: "pending" | "active" | "revoked";
          display_name?: string | null;
          notes?: string | null;
          invited_by?: string | null;
          invited_at?: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          last_login_at?: string | null;
          auth_user_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["resupply"]["Tables"]["admin_users"]["Insert"]>;
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          operator_email: string | null;
          operator_user_id: string | null;
          action: string;
          target_table: string | null;
          target_id: string | null;
          metadata: Json;
          ip: string | null;
          user_agent: string | null;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          operator_email?: string | null;
          operator_user_id?: string | null;
          action: string;
          target_table?: string | null;
          target_id?: string | null;
          metadata?: Json;
          ip?: string | null;
          user_agent?: string | null;
          occurred_at?: string;
        };
        Update: Partial<Database["resupply"]["Tables"]["audit_log"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
  resupply_auth: {
    Tables: {
      users: {
        Row: {
          id: string;
          email_lower: string;
          display_name: string | null;
          role: string;
          status: string;
          email_verified_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_lower: string;
          display_name?: string | null;
          role?: string;
          status?: string;
          email_verified_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["resupply_auth"]["Tables"]["users"]["Insert"]>;
        Relationships: [];
      };
      password_credentials: {
        Row: {
          user_id: string;
          password_hash: string;
          algo: string;
          must_change: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          password_hash: string;
          algo?: string;
          must_change?: boolean;
          updated_at?: string;
        };
        Update: Partial<
          Database["resupply_auth"]["Tables"]["password_credentials"]["Insert"]
        >;
        Relationships: [];
      };
      sessions: {
        Row: {
          id: string;
          // bytea — Supabase JS round-trips bytea as a hex string by
          // default ("\\x...").  Typed as `string` so the type system
          // matches what the wire actually carries; the in-house
          // helpers convert back to Buffer at the API boundary.
          token_hash: string;
          user_id: string;
          issued_at: string;
          expires_at: string;
          last_seen_at: string;
          revoked_at: string | null;
          ip: string | null;
          user_agent_hash: string | null;
        };
        Insert: {
          id?: string;
          token_hash: string;
          user_id: string;
          issued_at?: string;
          expires_at: string;
          last_seen_at?: string;
          revoked_at?: string | null;
          ip?: string | null;
          user_agent_hash?: string | null;
        };
        Update: Partial<Database["resupply_auth"]["Tables"]["sessions"]["Insert"]>;
        Relationships: [];
      };
      email_tokens: {
        Row: {
          token_hash: string;
          user_id: string;
          purpose: string;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        };
        Insert: {
          token_hash: string;
          user_id: string;
          purpose: string;
          expires_at: string;
          consumed_at?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["resupply_auth"]["Tables"]["email_tokens"]["Insert"]
        >;
        Relationships: [];
      };
      login_attempts: {
        Row: {
          id: number;
          email_lower: string;
          ip: string | null;
          success: boolean;
          attempted_at: string;
        };
        Insert: {
          id?: number;
          email_lower: string;
          ip?: string | null;
          success: boolean;
          attempted_at?: string;
        };
        Update: Partial<
          Database["resupply_auth"]["Tables"]["login_attempts"]["Insert"]
        >;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
