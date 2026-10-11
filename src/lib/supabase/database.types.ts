export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cron_health_log: {
        Row: {
          detail: string | null
          failure_class: string
          id: number
          jobid: number
          jobname: string
          logged_at: string
          occurred_at: string
          runid: number | null
          status: string | null
        }
        Insert: {
          detail?: string | null
          failure_class: string
          id?: never
          jobid: number
          jobname: string
          logged_at?: string
          occurred_at: string
          runid?: number | null
          status?: string | null
        }
        Update: {
          detail?: string | null
          failure_class?: string
          id?: never
          jobid?: number
          jobname?: string
          logged_at?: string
          occurred_at?: string
          runid?: number | null
          status?: string | null
        }
        Relationships: []
      }
      delete_account_attempts: {
        Row: {
          attempted_at: string
          id: string
          user_id: string
        }
        Insert: {
          attempted_at?: string
          id?: string
          user_id: string
        }
        Update: {
          attempted_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      euf_events: {
        Row: {
          created_at: string
          end_date: string | null
          id: string
          kind: Database["public"]["Enums"]["euf_event_kind"]
          last_scraped_at: string | null
          last_scraped_status: string | null
          location: string | null
          name: string
          season_id: string
          short_name: string | null
          slug: string
          source_origin: string | null
          start_date: string | null
          updated_at: string
          year: number
        }
        Insert: {
          created_at?: string
          end_date?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["euf_event_kind"]
          last_scraped_at?: string | null
          last_scraped_status?: string | null
          location?: string | null
          name: string
          season_id: string
          short_name?: string | null
          slug: string
          source_origin?: string | null
          start_date?: string | null
          updated_at?: string
          year: number
        }
        Update: {
          created_at?: string
          end_date?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["euf_event_kind"]
          last_scraped_at?: string | null
          last_scraped_status?: string | null
          location?: string | null
          name?: string
          season_id?: string
          short_name?: string | null
          slug?: string
          source_origin?: string | null
          start_date?: string | null
          updated_at?: string
          year?: number
        }
        Relationships: []
      }
      euf_game_player_stats: {
        Row: {
          assists: number
          created_at: string
          euf_player_id: number | null
          event_id: string
          full_name: string
          game_id: string
          goals: number
          id: string
          jersey_number: string | null
          team_id: string | null
          total: number
        }
        Insert: {
          assists?: number
          created_at?: string
          euf_player_id?: number | null
          event_id: string
          full_name: string
          game_id: string
          goals?: number
          id?: string
          jersey_number?: string | null
          team_id?: string | null
          total?: number
        }
        Update: {
          assists?: number
          created_at?: string
          euf_player_id?: number | null
          event_id?: string
          full_name?: string
          game_id?: string
          goals?: number
          id?: string
          jersey_number?: string | null
          team_id?: string | null
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "euf_game_player_stats_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "euf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "euf_game_player_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "euf_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "euf_game_player_stats_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "euf_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      euf_games: {
        Row: {
          away_score: number | null
          away_team_id: string | null
          created_at: string
          division: Database["public"]["Enums"]["euf_division"]
          euf_game_id: number | null
          event_id: string
          field: string | null
          home_score: number | null
          home_team_id: string | null
          id: string
          is_bracket: boolean
          round_name: string | null
          scheduled_at: string | null
          stage: Database["public"]["Enums"]["euf_game_stage"]
          start_time: string | null
          status: Database["public"]["Enums"]["euf_game_status"]
          updated_at: string
        }
        Insert: {
          away_score?: number | null
          away_team_id?: string | null
          created_at?: string
          division: Database["public"]["Enums"]["euf_division"]
          euf_game_id?: number | null
          event_id: string
          field?: string | null
          home_score?: number | null
          home_team_id?: string | null
          id?: string
          is_bracket?: boolean
          round_name?: string | null
          scheduled_at?: string | null
          stage?: Database["public"]["Enums"]["euf_game_stage"]
          start_time?: string | null
          status?: Database["public"]["Enums"]["euf_game_status"]
          updated_at?: string
        }
        Update: {
          away_score?: number | null
          away_team_id?: string | null
          created_at?: string
          division?: Database["public"]["Enums"]["euf_division"]
          euf_game_id?: number | null
          event_id?: string
          field?: string | null
          home_score?: number | null
          home_team_id?: string | null
          id?: string
          is_bracket?: boolean
          round_name?: string | null
          scheduled_at?: string | null
          stage?: Database["public"]["Enums"]["euf_game_stage"]
          start_time?: string | null
          status?: Database["public"]["Enums"]["euf_game_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "euf_games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "euf_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "euf_games_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "euf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "euf_games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "euf_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      euf_rosters: {
        Row: {
          assists: number | null
          created_at: string
          euf_player_id: number
          event_id: string
          full_name: string
          games: number | null
          goals: number | null
          id: string
          jersey_number: string | null
          name_key: string | null
          name_last_norm: string | null
          team_id: string
          total: number | null
        }
        Insert: {
          assists?: number | null
          created_at?: string
          euf_player_id: number
          event_id: string
          full_name: string
          games?: number | null
          goals?: number | null
          id?: string
          jersey_number?: string | null
          name_key?: string | null
          name_last_norm?: string | null
          team_id: string
          total?: number | null
        }
        Update: {
          assists?: number | null
          created_at?: string
          euf_player_id?: number
          event_id?: string
          full_name?: string
          games?: number | null
          goals?: number | null
          id?: string
          jersey_number?: string | null
          name_key?: string | null
          name_last_norm?: string | null
          team_id?: string
          total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "euf_rosters_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "euf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "euf_rosters_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "euf_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      euf_teams: {
        Row: {
          country_code: string | null
          country_name: string | null
          created_at: string
          division: Database["public"]["Enums"]["euf_division"]
          euf_team_id: number
          event_id: string
          final_placement: number | null
          games: number | null
          id: string
          losses: number | null
          name: string
          scores_against: number | null
          scores_for: number | null
          seed: number | null
          updated_at: string
          wins: number | null
        }
        Insert: {
          country_code?: string | null
          country_name?: string | null
          created_at?: string
          division: Database["public"]["Enums"]["euf_division"]
          euf_team_id: number
          event_id: string
          final_placement?: number | null
          games?: number | null
          id?: string
          losses?: number | null
          name: string
          scores_against?: number | null
          scores_for?: number | null
          seed?: number | null
          updated_at?: string
          wins?: number | null
        }
        Update: {
          country_code?: string | null
          country_name?: string | null
          created_at?: string
          division?: Database["public"]["Enums"]["euf_division"]
          euf_team_id?: number
          event_id?: string
          final_placement?: number | null
          games?: number | null
          id?: string
          losses?: number | null
          name?: string
          scores_against?: number | null
          scores_for?: number | null
          seed?: number | null
          updated_at?: string
          wins?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "euf_teams_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "euf_events"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_contest_periods: {
        Row: {
          complete: boolean
          contest_id: string
          game_count: number | null
          lock_at: string
          period: string
          unlock_at: string | null
          updated_at: string
        }
        Insert: {
          complete?: boolean
          contest_id: string
          game_count?: number | null
          lock_at: string
          period: string
          unlock_at?: string | null
          updated_at?: string
        }
        Update: {
          complete?: boolean
          contest_id?: string
          game_count?: number | null
          lock_at?: string
          period?: string
          unlock_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_contest_periods_contest_id_fkey"
            columns: ["contest_id"]
            isOneToOne: false
            referencedRelation: "fantasy_contests"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_contests: {
        Row: {
          competition: string
          created_at: string
          created_by: string | null
          id: string
          league_id: string
          name: string
          season_year: number
          settings: Json
          status: string
        }
        Insert: {
          competition: string
          created_at?: string
          created_by?: string | null
          id?: string
          league_id: string
          name: string
          season_year: number
          settings?: Json
          status?: string
        }
        Update: {
          competition?: string
          created_at?: string
          created_by?: string | null
          id?: string
          league_id?: string
          name?: string
          season_year?: number
          settings?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_contests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_contests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_contests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_contests_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "fantasy_leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_league_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          last_sent_at: string | null
          league_id: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          last_sent_at?: string | null
          league_id: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          last_sent_at?: string | null
          league_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_league_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_league_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_league_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_league_invites_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "fantasy_leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_league_members: {
        Row: {
          id: string
          joined_at: string
          league_id: string
          member_display_name: string | null
          member_username: string | null
          role: string
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string
          league_id: string
          member_display_name?: string | null
          member_username?: string | null
          role?: string
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string
          league_id?: string
          member_display_name?: string | null
          member_username?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_league_members_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "fantasy_leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_league_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_league_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_league_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_leagues: {
        Row: {
          created_at: string
          id: string
          invite_token: string | null
          name: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invite_token?: string | null
          name: string
          owner_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invite_token?: string | null
          name?: string
          owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_leagues_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_leagues_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_leagues_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_player_ratings: {
        Row: {
          avg_assists: number
          avg_goals: number
          computed_at: string
          division: string | null
          division_rank: number | null
          elite_select_events: number
          event_id: string
          nationals: number
          player_id: string
          player_league: string
          player_name: string
          pro_elite_events: number
          rank: number
          score: number | null
          select_events: number
          stat_events: number
          team_name: string | null
          tct_events: number
          tier: string
        }
        Insert: {
          avg_assists: number
          avg_goals: number
          computed_at?: string
          division?: string | null
          division_rank?: number | null
          elite_select_events: number
          event_id: string
          nationals: number
          player_id: string
          player_league: string
          player_name: string
          pro_elite_events: number
          rank: number
          score?: number | null
          select_events: number
          stat_events: number
          team_name?: string | null
          tct_events: number
          tier: string
        }
        Update: {
          avg_assists?: number
          avg_goals?: number
          computed_at?: string
          division?: string | null
          division_rank?: number | null
          elite_select_events?: number
          event_id?: string
          nationals?: number
          player_id?: string
          player_league?: string
          player_name?: string
          pro_elite_events?: number
          rank?: number
          score?: number | null
          select_events?: number
          stat_events?: number
          team_name?: string | null
          tct_events?: number
          tier?: string
        }
        Relationships: []
      }
      fantasy_roster_slots: {
        Row: {
          created_at: string
          id: string
          player_id: string
          player_league: string
          role: string
          team_id: string
          week: string
        }
        Insert: {
          created_at?: string
          id?: string
          player_id: string
          player_league?: string
          role: string
          team_id: string
          week: string
        }
        Update: {
          created_at?: string
          id?: string
          player_id?: string
          player_league?: string
          role?: string
          team_id?: string
          week?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_roster_slots_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "fantasy_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_scores: {
        Row: {
          computed_at: string
          id: string
          points: number
          team_id: string
          week: string
        }
        Insert: {
          computed_at?: string
          id?: string
          points?: number
          team_id: string
          week: string
        }
        Update: {
          computed_at?: string
          id?: string
          points?: number
          team_id?: string
          week?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_scores_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "fantasy_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasy_scores_backup_20260815: {
        Row: {
          computed_at: string | null
          id: string | null
          points: number | null
          team_id: string | null
          week: string | null
        }
        Insert: {
          computed_at?: string | null
          id?: string | null
          points?: number | null
          team_id?: string | null
          week?: string | null
        }
        Update: {
          computed_at?: string | null
          id?: string | null
          points?: number | null
          team_id?: string | null
          week?: string | null
        }
        Relationships: []
      }
      fantasy_teams: {
        Row: {
          contest_id: string
          created_at: string
          id: string
          league_id: string | null
          owner_display_name: string | null
          owner_id: string
          owner_username: string | null
          season_year: number
          team_name: string
          updated_at: string
        }
        Insert: {
          contest_id: string
          created_at?: string
          id?: string
          league_id?: string | null
          owner_display_name?: string | null
          owner_id: string
          owner_username?: string | null
          season_year: number
          team_name: string
          updated_at?: string
        }
        Update: {
          contest_id?: string
          created_at?: string
          id?: string
          league_id?: string | null
          owner_display_name?: string | null
          owner_id?: string
          owner_username?: string | null
          season_year?: number
          team_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fantasy_teams_contest_id_fkey"
            columns: ["contest_id"]
            isOneToOne: false
            referencedRelation: "fantasy_contests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_teams_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "fantasy_leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasy_teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          category: string | null
          created_at: string
          id: string
          message: string
          page_path: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["feedback_status"]
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          message: string
          page_path?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["feedback_status"]
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          message?: string
          page_path?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["feedback_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_user_id_profiles_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
          reason: string | null
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
          reason?: string | null
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jersey_blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_listing_events: {
        Row: {
          created_at: string
          event_name: string | null
          event_starts_on: string | null
          id: string
          listing_id: string | null
          usau_event_id: string | null
          want_id: string | null
        }
        Insert: {
          created_at?: string
          event_name?: string | null
          event_starts_on?: string | null
          id?: string
          listing_id?: string | null
          usau_event_id?: string | null
          want_id?: string | null
        }
        Update: {
          created_at?: string
          event_name?: string | null
          event_starts_on?: string | null
          id?: string
          listing_id?: string | null
          usau_event_id?: string | null
          want_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jersey_listing_events_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "jersey_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_listing_events_usau_event_id_fkey"
            columns: ["usau_event_id"]
            isOneToOne: false
            referencedRelation: "usau_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_listing_events_want_id_fkey"
            columns: ["want_id"]
            isOneToOne: false
            referencedRelation: "jersey_wants"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_listings: {
        Row: {
          city: string | null
          condition: Database["public"]["Enums"]["jersey_condition"] | null
          country: string | null
          created_at: string
          description: string | null
          id: string
          kind: Database["public"]["Enums"]["jersey_listing_kind"]
          league: string | null
          league_name: string | null
          owner_id: string
          player_name: string | null
          price_cents: number | null
          size: string | null
          state: string | null
          status: Database["public"]["Enums"]["jersey_listing_status"]
          team_id: string | null
          team_logo_url: string | null
          team_name: string | null
          title: string
          updated_at: string
          year: number | null
        }
        Insert: {
          city?: string | null
          condition?: Database["public"]["Enums"]["jersey_condition"] | null
          country?: string | null
          created_at?: string
          description?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["jersey_listing_kind"]
          league?: string | null
          league_name?: string | null
          owner_id: string
          player_name?: string | null
          price_cents?: number | null
          size?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["jersey_listing_status"]
          team_id?: string | null
          team_logo_url?: string | null
          team_name?: string | null
          title: string
          updated_at?: string
          year?: number | null
        }
        Update: {
          city?: string | null
          condition?: Database["public"]["Enums"]["jersey_condition"] | null
          country?: string | null
          created_at?: string
          description?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["jersey_listing_kind"]
          league?: string | null
          league_name?: string | null
          owner_id?: string
          player_name?: string | null
          price_cents?: number | null
          size?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["jersey_listing_status"]
          team_id?: string | null
          team_logo_url?: string | null
          team_name?: string | null
          title?: string
          updated_at?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "jersey_listings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_listings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_listings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_messages: {
        Row: {
          body: string
          created_at: string
          id: string
          sender_id: string
          thread_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          sender_id: string
          thread_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          sender_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "jersey_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "jersey_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_photos: {
        Row: {
          created_at: string
          id: string
          listing_id: string
          sort_order: number
          storage_path: string
        }
        Insert: {
          created_at?: string
          id?: string
          listing_id: string
          sort_order?: number
          storage_path: string
        }
        Update: {
          created_at?: string
          id?: string
          listing_id?: string
          sort_order?: number
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "jersey_photos_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "jersey_listings"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_reports: {
        Row: {
          created_at: string
          detail: string | null
          id: string
          listing_id: string | null
          reason: string
          reported_user_id: string | null
          reporter_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["jersey_report_status"]
          thread_id: string | null
          want_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: string
          listing_id?: string | null
          reason: string
          reported_user_id?: string | null
          reporter_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["jersey_report_status"]
          thread_id?: string | null
          want_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: string
          listing_id?: string | null
          reason?: string
          reported_user_id?: string | null
          reporter_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["jersey_report_status"]
          thread_id?: string | null
          want_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jersey_reports_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "jersey_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reported_user_id_fkey"
            columns: ["reported_user_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reported_user_id_fkey"
            columns: ["reported_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reported_user_id_fkey"
            columns: ["reported_user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_thread_fk"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "jersey_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_reports_want_id_fkey"
            columns: ["want_id"]
            isOneToOne: false
            referencedRelation: "jersey_wants"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_threads: {
        Row: {
          created_at: string
          id: string
          last_message_at: string | null
          listing_id: string | null
          owner_id: string
          owner_last_read_at: string | null
          requester_id: string
          requester_last_read_at: string | null
          want_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          listing_id?: string | null
          owner_id: string
          owner_last_read_at?: string | null
          requester_id: string
          requester_last_read_at?: string | null
          want_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_message_at?: string | null
          listing_id?: string | null
          owner_id?: string
          owner_last_read_at?: string | null
          requester_id?: string
          requester_last_read_at?: string | null
          want_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jersey_threads_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "jersey_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_threads_want_id_fkey"
            columns: ["want_id"]
            isOneToOne: false
            referencedRelation: "jersey_wants"
            referencedColumns: ["id"]
          },
        ]
      }
      jersey_wants: {
        Row: {
          city: string | null
          country: string | null
          created_at: string
          id: string
          league: string | null
          league_name: string | null
          note: string | null
          player_name: string | null
          size: string | null
          state: string | null
          status: Database["public"]["Enums"]["jersey_listing_status"]
          team_id: string | null
          team_logo_url: string | null
          team_name: string | null
          updated_at: string
          user_id: string
          year: number | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          league?: string | null
          league_name?: string | null
          note?: string | null
          player_name?: string | null
          size?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["jersey_listing_status"]
          team_id?: string | null
          team_logo_url?: string | null
          team_name?: string | null
          updated_at?: string
          user_id: string
          year?: number | null
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          league?: string | null
          league_name?: string | null
          note?: string | null
          player_name?: string | null
          size?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["jersey_listing_status"]
          team_id?: string | null
          team_logo_url?: string | null
          team_name?: string | null
          updated_at?: string
          user_id?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "jersey_wants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_wants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jersey_wants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_prefs: {
        Row: {
          game_final: boolean
          game_start: boolean
          news: boolean
          push_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          game_final?: boolean
          game_start?: boolean
          news?: boolean
          push_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          game_final?: boolean
          game_start?: boolean
          news?: boolean
          push_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      pb_play_steps: {
        Row: {
          created_at: string
          duration_ms: number
          id: string
          note: string | null
          payload: Json
          play_id: string
          position: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number
          id?: string
          note?: string | null
          payload: Json
          play_id: string
          position: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          duration_ms?: number
          id?: string
          note?: string | null
          payload?: Json
          play_id?: string
          position?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "play_steps_play_id_fkey"
            columns: ["play_id"]
            isOneToOne: false
            referencedRelation: "pb_plays"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_line_players: {
        Row: {
          line_id: string
          player_id: string
          sort_order: number
        }
        Insert: {
          line_id: string
          player_id: string
          sort_order?: number
        }
        Update: {
          line_id?: string
          player_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "pb_line_players_line_id_fkey"
            columns: ["line_id"]
            isOneToOne: false
            referencedRelation: "pb_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pb_line_players_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "pb_roster_players"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_lines: {
        Row: {
          created_at: string
          created_by: string
          id: string
          kind: string
          name: string
          note: string | null
          sort_order: number
          team_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          kind?: string
          name: string
          note?: string | null
          sort_order?: number
          team_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          kind?: string
          name?: string
          note?: string | null
          sort_order?: number
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pb_lines_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pb_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_plays: {
        Row: {
          created_at: string
          created_by: string
          field_type: string
          formation: string
          id: string
          name: string
          owner_id: string | null
          tags: string[]
          team_id: string | null
          updated_at: string
          video_url: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          field_type?: string
          formation: string
          id?: string
          name: string
          owner_id?: string | null
          tags?: string[]
          team_id?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          field_type?: string
          formation?: string
          id?: string
          name?: string
          owner_id?: string | null
          tags?: string[]
          team_id?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plays_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plays_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plays_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plays_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plays_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pb_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_play_personnel: {
        Row: {
          play_id: string
          player_id: string
          slot: number
        }
        Insert: {
          play_id: string
          player_id: string
          slot: number
        }
        Update: {
          play_id?: string
          player_id?: string
          slot?: number
        }
        Relationships: [
          {
            foreignKeyName: "pb_play_personnel_play_id_fkey"
            columns: ["play_id"]
            isOneToOne: false
            referencedRelation: "pb_plays"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pb_play_personnel_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "pb_roster_players"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_roster_players: {
        Row: {
          active: boolean
          created_at: string
          created_by: string
          id: string
          name: string
          note: string | null
          number: string | null
          position: string
          sort_order: number
          team_id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string
          id?: string
          name: string
          note?: string | null
          number?: string | null
          position?: string
          sort_order?: number
          team_id: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          note?: string | null
          number?: string | null
          position?: string
          sort_order?: number
          team_id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pb_roster_players_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pb_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_team_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          last_sent_at: string | null
          role: Database["public"]["Enums"]["pb_team_role"]
          team_id: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          last_sent_at?: string | null
          role?: Database["public"]["Enums"]["pb_team_role"]
          team_id: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          last_sent_at?: string | null
          role?: Database["public"]["Enums"]["pb_team_role"]
          team_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invites_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pb_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_team_members: {
        Row: {
          joined_at: string
          role: Database["public"]["Enums"]["pb_team_role"]
          team_id: string
          user_id: string
        }
        Insert: {
          joined_at?: string
          role?: Database["public"]["Enums"]["pb_team_role"]
          team_id: string
          user_id: string
        }
        Update: {
          joined_at?: string
          role?: Database["public"]["Enums"]["pb_team_role"]
          team_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pb_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      pb_teams: {
        Row: {
          color: string
          created_at: string
          id: string
          name: string
          owner_id: string
          short_name: string
          updated_at: string
        }
        Insert: {
          color: string
          created_at?: string
          id?: string
          name: string
          owner_id: string
          short_name: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          short_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      player_content: {
        Row: {
          caption: string | null
          created_at: string
          external_url: string | null
          file_size_bytes: number | null
          id: string
          kind: Database["public"]["Enums"]["player_content_kind"]
          mime_type: string | null
          player_display_name: string
          player_kind: string
          player_ref: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["player_content_status"]
          storage_path: string | null
          updated_at: string
          uploaded_by: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          external_url?: string | null
          file_size_bytes?: number | null
          id?: string
          kind: Database["public"]["Enums"]["player_content_kind"]
          mime_type?: string | null
          player_display_name: string
          player_kind: string
          player_ref: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["player_content_status"]
          storage_path?: string | null
          updated_at?: string
          uploaded_by: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          external_url?: string | null
          file_size_bytes?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["player_content_kind"]
          mime_type?: string | null
          player_display_name?: string
          player_kind?: string
          player_ref?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["player_content_status"]
          storage_path?: string | null
          updated_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_content_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_content_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_content_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_content_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profile_contact"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_content_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_content_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      player_content_reports: {
        Row: {
          content_id: string
          created_at: string
          id: string
          reason: string
          reporter_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["player_content_report_status"]
        }
        Insert: {
          content_id: string
          created_at?: string
          id?: string
          reason: string
          reporter_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["player_content_report_status"]
        }
        Update: {
          content_id?: string
          created_at?: string
          id?: string
          reason?: string
          reporter_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["player_content_report_status"]
        }
        Relationships: [
          {
            foreignKeyName: "player_content_reports_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "player_content"
            referencedColumns: ["id"]
          },
        ]
      }
      player_edges: {
        Row: {
          ctx: string[]
          last_season: number | null
          leagues: string[]
          name_a: string
          name_b: string
          weight: number
        }
        Insert: {
          ctx?: string[]
          last_season?: number | null
          leagues?: string[]
          name_a: string
          name_b: string
          weight?: number
        }
        Update: {
          ctx?: string[]
          last_season?: number | null
          leagues?: string[]
          name_a?: string
          name_b?: string
          weight?: number
        }
        Relationships: []
      }
      player_nodes: {
        Row: {
          championships: number
          display_name: string
          is_champion: boolean
          last_season: number | null
          leagues: string[]
          name: string
          nationals_seasons: number[]
          teammate_count: number
          teams: string[]
          ufa_career_score: number | null
        }
        Insert: {
          championships?: number
          display_name: string
          is_champion?: boolean
          last_season?: number | null
          leagues?: string[]
          name: string
          nationals_seasons?: number[]
          teammate_count?: number
          teams?: string[]
          ufa_career_score?: number | null
        }
        Update: {
          championships?: number
          display_name?: string
          is_champion?: boolean
          last_season?: number | null
          leagues?: string[]
          name?: string
          nationals_seasons?: number[]
          teammate_count?: number
          teams?: string[]
          ufa_career_score?: number | null
        }
        Relationships: []
      }
      player_profiles: {
        Row: {
          anchor_id: string
          anchor_league: string | null
          build_ms: number | null
          built_at: string
          profile: Json
        }
        Insert: {
          anchor_id: string
          anchor_league?: string | null
          build_ms?: number | null
          built_at?: string
          profile: Json
        }
        Update: {
          anchor_id?: string
          anchor_league?: string | null
          build_ms?: number | null
          built_at?: string
          profile?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_icon: string | null
          playbook_scope: string | null
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
          username: string | null
        }
        Insert: {
          avatar_icon?: string | null
          playbook_scope?: string | null
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          username?: string | null
        }
        Update: {
          avatar_icon?: string | null
          playbook_scope?: string | null
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      pul_game_player_stats: {
        Row: {
          assists: number
          blocks: number
          created_at: string
          d_points: number
          game_id: string
          goals: number
          id: string
          jersey_number: string
          o_points: number
          player_name: string
          plus_minus: number
          team_id: string
          touches: number
          turnovers: number
          updated_at: string
        }
        Insert: {
          assists?: number
          blocks?: number
          created_at?: string
          d_points?: number
          game_id: string
          goals?: number
          id?: string
          jersey_number?: string
          o_points?: number
          player_name: string
          plus_minus?: number
          team_id: string
          touches?: number
          turnovers?: number
          updated_at?: string
        }
        Update: {
          assists?: number
          blocks?: number
          created_at?: string
          d_points?: number
          game_id?: string
          goals?: number
          id?: string
          jersey_number?: string
          o_points?: number
          player_name?: string
          plus_minus?: number
          team_id?: string
          touches?: number
          turnovers?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pul_game_player_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "pul_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pul_game_player_stats_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pul_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pul_games: {
        Row: {
          away_abbrev: string
          away_score: number | null
          away_team_id: string
          created_at: string
          game_date: string | null
          game_time: string | null
          home_abbrev: string
          home_score: number | null
          home_team_id: string
          id: string
          location: string | null
          season: number
          status: string
          updated_at: string
          week_label: string
          week_num: number | null
        }
        Insert: {
          away_abbrev: string
          away_score?: number | null
          away_team_id: string
          created_at?: string
          game_date?: string | null
          game_time?: string | null
          home_abbrev: string
          home_score?: number | null
          home_team_id: string
          id: string
          location?: string | null
          season: number
          status?: string
          updated_at?: string
          week_label: string
          week_num?: number | null
        }
        Update: {
          away_abbrev?: string
          away_score?: number | null
          away_team_id?: string
          created_at?: string
          game_date?: string | null
          game_time?: string | null
          home_abbrev?: string
          home_score?: number | null
          home_team_id?: string
          id?: string
          location?: string | null
          season?: number
          status?: string
          updated_at?: string
          week_label?: string
          week_num?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pul_games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "pul_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pul_games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "pul_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pul_players: {
        Row: {
          assists: number
          blocks: number
          created_at: string
          d_points: number
          games_played: number
          goals: number
          id: string
          jersey_number: string
          o_points: number
          player_name: string
          plus_minus: number
          pronouns: string | null
          season: number
          team_id: string
          touches: number
          turnovers: number
          updated_at: string
        }
        Insert: {
          assists?: number
          blocks?: number
          created_at?: string
          d_points?: number
          games_played?: number
          goals?: number
          id?: string
          jersey_number?: string
          o_points?: number
          player_name: string
          plus_minus?: number
          pronouns?: string | null
          season?: number
          team_id: string
          touches?: number
          turnovers?: number
          updated_at?: string
        }
        Update: {
          assists?: number
          blocks?: number
          created_at?: string
          d_points?: number
          games_played?: number
          goals?: number
          id?: string
          jersey_number?: string
          o_points?: number
          player_name?: string
          plus_minus?: number
          pronouns?: string | null
          season?: number
          team_id?: string
          touches?: number
          turnovers?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pul_players_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "pul_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pul_sync_log: {
        Row: {
          alert_sent: boolean
          box_rows: number
          created_at: string
          error: string | null
          finished_at: string | null
          games_checked: number
          games_inserted: number
          games_updated: number
          id: string
          started_at: string
          status: string
        }
        Insert: {
          alert_sent?: boolean
          box_rows?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          games_checked?: number
          games_inserted?: number
          games_updated?: number
          id?: string
          started_at?: string
          status?: string
        }
        Update: {
          alert_sent?: boolean
          box_rows?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          games_checked?: number
          games_inserted?: number
          games_updated?: number
          id?: string
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      pul_teams: {
        Row: {
          accent_color: string | null
          city: string
          created_at: string
          id: string
          logo_url: string | null
          mascot: string
          name: string
          updated_at: string
        }
        Insert: {
          accent_color?: string | null
          city: string
          created_at?: string
          id: string
          logo_url?: string | null
          mascot: string
          name: string
          updated_at?: string
        }
        Update: {
          accent_color?: string | null
          city?: string
          created_at?: string
          id?: string
          logo_url?: string | null
          mascot?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      push_tokens: {
        Row: {
          created_at: string
          id: string
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          platform: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      twelve_oh_baseline: {
        Row: {
          computed_at: string
          id: number
          mean_assists: number
          mean_blocks: number
          mean_callahans: number | null
          mean_completion_pct: number
          mean_drops: number | null
          mean_goals: number
          mean_hockey_assists: number
          mean_plus_minus: number
          mean_points_played: number | null
          mean_throwaways: number | null
          mean_yards_received: number
          mean_yards_thrown: number
          player_seasons: number
          raw_score_max: number
          raw_score_min: number
          raw_score_p5: number
          raw_score_p95: number
          std_assists: number
          std_blocks: number
          std_callahans: number | null
          std_completion_pct: number
          std_drops: number | null
          std_goals: number
          std_hockey_assists: number
          std_plus_minus: number
          std_points_played: number | null
          std_throwaways: number | null
          std_yards_received: number
          std_yards_thrown: number
        }
        Insert: {
          computed_at?: string
          id?: number
          mean_assists: number
          mean_blocks: number
          mean_callahans?: number | null
          mean_completion_pct: number
          mean_drops?: number | null
          mean_goals: number
          mean_hockey_assists: number
          mean_plus_minus: number
          mean_points_played?: number | null
          mean_throwaways?: number | null
          mean_yards_received: number
          mean_yards_thrown: number
          player_seasons: number
          raw_score_max: number
          raw_score_min: number
          raw_score_p5: number
          raw_score_p95: number
          std_assists: number
          std_blocks: number
          std_callahans?: number | null
          std_completion_pct: number
          std_drops?: number | null
          std_goals: number
          std_hockey_assists: number
          std_plus_minus: number
          std_points_played?: number | null
          std_throwaways?: number | null
          std_yards_received: number
          std_yards_thrown: number
        }
        Update: {
          computed_at?: string
          id?: number
          mean_assists?: number
          mean_blocks?: number
          mean_callahans?: number | null
          mean_completion_pct?: number
          mean_drops?: number | null
          mean_goals?: number
          mean_hockey_assists?: number
          mean_plus_minus?: number
          mean_points_played?: number | null
          mean_throwaways?: number | null
          mean_yards_received?: number
          mean_yards_thrown?: number
          player_seasons?: number
          raw_score_max?: number
          raw_score_min?: number
          raw_score_p5?: number
          raw_score_p95?: number
          std_assists?: number
          std_blocks?: number
          std_callahans?: number | null
          std_completion_pct?: number
          std_drops?: number | null
          std_goals?: number
          std_hockey_assists?: number
          std_plus_minus?: number
          std_points_played?: number | null
          std_throwaways?: number | null
          std_yards_received?: number
          std_yards_thrown?: number
        }
        Relationships: []
      }
      twelve_oh_league_baselines: {
        Row: {
          computed_at: string
          league: string
          payload: Json
          player_seasons: number
        }
        Insert: {
          computed_at?: string
          league: string
          payload: Json
          player_seasons: number
        }
        Update: {
          computed_at?: string
          league?: string
          payload?: Json
          player_seasons?: number
        }
        Relationships: []
      }
      twelve_oh_players: {
        Row: {
          assists: number
          backfill_version: number
          blocks: number
          callahans: number
          completion_pct: number | null
          completions: number
          created_at: string
          d_points: number | null
          drops: number
          games_played: number
          goals: number
          hockey_assists: number
          huck_pct: number | null
          hucks_completed: number
          league: string
          name: string
          o_points: number | null
          player_id: string
          player_score: number
          plus_minus: number
          points_played: number
          team_abbr: string
          team_internal_id: number
          team_slug: string
          touches: number | null
          turnovers: number
          updated_at: string
          yards_received: number
          yards_thrown: number
          year: number
          z_assists: number | null
          z_blocks: number | null
          z_callahans: number | null
          z_completion_pct: number | null
          z_drops: number | null
          z_goals: number | null
          z_hockey_assists: number | null
          z_plus_minus: number | null
          z_points_played: number | null
          z_throwaways: number | null
          z_yards_received: number | null
          z_yards_thrown: number | null
        }
        Insert: {
          assists?: number
          backfill_version?: number
          blocks?: number
          callahans?: number
          completion_pct?: number | null
          completions?: number
          created_at?: string
          d_points?: number | null
          drops?: number
          games_played?: number
          goals?: number
          hockey_assists?: number
          huck_pct?: number | null
          hucks_completed?: number
          league?: string
          name: string
          o_points?: number | null
          player_id: string
          player_score?: number
          plus_minus?: number
          points_played?: number
          team_abbr: string
          team_internal_id: number
          team_slug: string
          touches?: number | null
          turnovers?: number
          updated_at?: string
          yards_received?: number
          yards_thrown?: number
          year: number
          z_assists?: number | null
          z_blocks?: number | null
          z_callahans?: number | null
          z_completion_pct?: number | null
          z_drops?: number | null
          z_goals?: number | null
          z_hockey_assists?: number | null
          z_plus_minus?: number | null
          z_points_played?: number | null
          z_throwaways?: number | null
          z_yards_received?: number | null
          z_yards_thrown?: number | null
        }
        Update: {
          assists?: number
          backfill_version?: number
          blocks?: number
          callahans?: number
          completion_pct?: number | null
          completions?: number
          created_at?: string
          d_points?: number | null
          drops?: number
          games_played?: number
          goals?: number
          hockey_assists?: number
          huck_pct?: number | null
          hucks_completed?: number
          league?: string
          name?: string
          o_points?: number | null
          player_id?: string
          player_score?: number
          plus_minus?: number
          points_played?: number
          team_abbr?: string
          team_internal_id?: number
          team_slug?: string
          touches?: number | null
          turnovers?: number
          updated_at?: string
          yards_received?: number
          yards_thrown?: number
          year?: number
          z_assists?: number | null
          z_blocks?: number | null
          z_callahans?: number | null
          z_completion_pct?: number | null
          z_drops?: number | null
          z_goals?: number | null
          z_hockey_assists?: number | null
          z_plus_minus?: number | null
          z_points_played?: number | null
          z_throwaways?: number | null
          z_yards_received?: number | null
          z_yards_thrown?: number | null
        }
        Relationships: []
      }
      ufa_game_player_stats: {
        Row: {
          assists: number
          blocks: number
          callahans: number
          catches: number
          completions: number
          created_at: string
          d_points_played: number
          d_points_scored: number
          drops: number
          game_id: string
          goals: number
          hockey_assists: number
          hucks_attempted: number
          hucks_completed: number
          id: number
          is_home: boolean | null
          o_points_played: number
          o_points_scored: number
          player_id: string
          pulls: number
          seconds_played: number
          stalls: number
          team_id: string | null
          throwaways: number
          throws_attempted: number
          updated_at: string
          yards_received: number
          yards_thrown: number
        }
        Insert: {
          assists?: number
          blocks?: number
          callahans?: number
          catches?: number
          completions?: number
          created_at?: string
          d_points_played?: number
          d_points_scored?: number
          drops?: number
          game_id: string
          goals?: number
          hockey_assists?: number
          hucks_attempted?: number
          hucks_completed?: number
          id?: never
          is_home?: boolean | null
          o_points_played?: number
          o_points_scored?: number
          player_id: string
          pulls?: number
          seconds_played?: number
          stalls?: number
          team_id?: string | null
          throwaways?: number
          throws_attempted?: number
          updated_at?: string
          yards_received?: number
          yards_thrown?: number
        }
        Update: {
          assists?: number
          blocks?: number
          callahans?: number
          catches?: number
          completions?: number
          created_at?: string
          d_points_played?: number
          d_points_scored?: number
          drops?: number
          game_id?: string
          goals?: number
          hockey_assists?: number
          hucks_attempted?: number
          hucks_completed?: number
          id?: never
          is_home?: boolean | null
          o_points_played?: number
          o_points_scored?: number
          player_id?: string
          pulls?: number
          seconds_played?: number
          stalls?: number
          team_id?: string | null
          throwaways?: number
          throws_attempted?: number
          updated_at?: string
          yards_received?: number
          yards_thrown?: number
        }
        Relationships: [
          {
            foreignKeyName: "ufa_game_player_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "ufa_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ufa_game_player_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "ufa_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ufa_game_player_stats_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "ufa_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      ufa_games: {
        Row: {
          away_score: number | null
          away_team_id: string | null
          created_at: string
          home_score: number | null
          home_team_id: string | null
          id: string
          location_name: string | null
          start_timestamp: string | null
          status: string
          updated_at: string
          week: string | null
          year: number
        }
        Insert: {
          away_score?: number | null
          away_team_id?: string | null
          created_at?: string
          home_score?: number | null
          home_team_id?: string | null
          id: string
          location_name?: string | null
          start_timestamp?: string | null
          status?: string
          updated_at?: string
          week?: string | null
          year: number
        }
        Update: {
          away_score?: number | null
          away_team_id?: string | null
          created_at?: string
          home_score?: number | null
          home_team_id?: string | null
          id?: string
          location_name?: string | null
          start_timestamp?: string | null
          status?: string
          updated_at?: string
          week?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "ufa_games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "ufa_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ufa_games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "ufa_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      ufa_players: {
        Row: {
          created_at: string
          current_team_id: string | null
          first_name: string | null
          full_name: string | null
          headshot_url: string | null
          id: string
          last_name: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_team_id?: string | null
          first_name?: string | null
          full_name?: string | null
          headshot_url?: string | null
          id: string
          last_name?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_team_id?: string | null
          first_name?: string | null
          full_name?: string | null
          headshot_url?: string | null
          id?: string
          last_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ufa_players_current_team_id_fkey"
            columns: ["current_team_id"]
            isOneToOne: false
            referencedRelation: "ufa_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      ufa_teams: {
        Row: {
          abbr: string | null
          city: string | null
          created_at: string
          division: string | null
          full_name: string | null
          id: string
          logo_url: string | null
          name: string
          updated_at: string
        }
        Insert: {
          abbr?: string | null
          city?: string | null
          created_at?: string
          division?: string | null
          full_name?: string | null
          id: string
          logo_url?: string | null
          name: string
          updated_at?: string
        }
        Update: {
          abbr?: string | null
          city?: string | null
          created_at?: string
          division?: string | null
          full_name?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      usau_api_coverage: {
        Row: {
          checked_at: string
          id: string
          live_group_ids: number[]
          new_event_pages: string[]
          new_site_rows: number
          notes: string | null
          play_site_rows: number
          source: string
          total_rows: number
        }
        Insert: {
          checked_at?: string
          id?: string
          live_group_ids?: number[]
          new_event_pages?: string[]
          new_site_rows: number
          notes?: string | null
          play_site_rows: number
          source: string
          total_rows: number
        }
        Update: {
          checked_at?: string
          id?: string
          live_group_ids?: number[]
          new_event_pages?: string[]
          new_site_rows?: number
          notes?: string | null
          play_site_rows?: number
          source?: string
          total_rows?: number
        }
        Relationships: []
      }
      usau_event_teams: {
        Row: {
          event_id: string
          final_placement: number | null
          pool: string | null
          seed: number | null
          team_id: string
          usau_event_team_id: string
          usau_event_team_url_id: string | null
        }
        Insert: {
          event_id: string
          final_placement?: number | null
          pool?: string | null
          seed?: number | null
          team_id: string
          usau_event_team_id: string
          usau_event_team_url_id?: string | null
        }
        Update: {
          event_id?: string
          final_placement?: number | null
          pool?: string | null
          seed?: number | null
          team_id?: string
          usau_event_team_id?: string
          usau_event_team_url_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usau_event_teams_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "usau_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usau_event_teams_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "usau_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      usau_event_templates: {
        Row: {
          competition_level: Database["public"]["Enums"]["usau_competition_level"]
          created_at: string
          display_name: string
          gender_division:
            | Database["public"]["Enums"]["usau_gender_division"]
            | null
          id: string
          is_flagship: boolean | null
          key: string
          known_slugs: Json
          match_rules: Json | null
          skip_years: number[]
          slug_pattern: string | null
          tried_slugs: Json
          updated_at: string
        }
        Insert: {
          competition_level?: Database["public"]["Enums"]["usau_competition_level"]
          created_at?: string
          display_name: string
          gender_division?:
            | Database["public"]["Enums"]["usau_gender_division"]
            | null
          id?: string
          is_flagship?: boolean | null
          key: string
          known_slugs?: Json
          match_rules?: Json | null
          skip_years?: number[]
          slug_pattern?: string | null
          tried_slugs?: Json
          updated_at?: string
        }
        Update: {
          competition_level?: Database["public"]["Enums"]["usau_competition_level"]
          created_at?: string
          display_name?: string
          gender_division?:
            | Database["public"]["Enums"]["usau_gender_division"]
            | null
          id?: string
          is_flagship?: boolean | null
          key?: string
          known_slugs?: Json
          match_rules?: Json | null
          skip_years?: number[]
          slug_pattern?: string | null
          tried_slugs?: Json
          updated_at?: string
        }
        Relationships: []
      }
      usau_events: {
        Row: {
          city: string | null
          competition_level: Database["public"]["Enums"]["usau_competition_level"]
          created_at: string
          end_date: string | null
          event_type: Database["public"]["Enums"]["usau_event_type"]
          flight_rank: number | null
          id: string
          is_sanctioned: boolean
          last_scraped_at: string | null
          last_scraped_status: string | null
          name: string
          season: number
          series_division: string | null
          series_group_key: string | null
          series_group_name: string | null
          series_stage: string | null
          series_tier: string | null
          start_date: string | null
          state: string | null
          template_key: string | null
          updated_at: string
          url: string | null
          venue: string | null
          venue_tz: string | null
          usau_event_id: number | null
          usau_slug: string
        }
        Insert: {
          city?: string | null
          competition_level?: Database["public"]["Enums"]["usau_competition_level"]
          created_at?: string
          end_date?: string | null
          event_type?: Database["public"]["Enums"]["usau_event_type"]
          id?: string
          is_sanctioned?: boolean
          last_scraped_at?: string | null
          last_scraped_status?: string | null
          name: string
          season: number
          start_date?: string | null
          state?: string | null
          template_key?: string | null
          updated_at?: string
          url?: string | null
          venue?: string | null
          venue_tz?: string | null
          usau_event_id?: number | null
          usau_slug: string
        }
        Update: {
          city?: string | null
          competition_level?: Database["public"]["Enums"]["usau_competition_level"]
          created_at?: string
          end_date?: string | null
          event_type?: Database["public"]["Enums"]["usau_event_type"]
          id?: string
          is_sanctioned?: boolean
          last_scraped_at?: string | null
          last_scraped_status?: string | null
          name?: string
          season?: number
          start_date?: string | null
          state?: string | null
          template_key?: string | null
          updated_at?: string
          url?: string | null
          venue?: string | null
          venue_tz?: string | null
          usau_event_id?: number | null
          usau_slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "usau_events_season_fkey"
            columns: ["season"]
            isOneToOne: false
            referencedRelation: "usau_seasons"
            referencedColumns: ["year"]
          },
        ]
      }
      usau_games: {
        Row: {
          bracket_name: string | null
          created_at: string
          event_id: string
          id: string
          location: string | null
          played_at: string | null
          round: Database["public"]["Enums"]["usau_game_round"]
          scheduled_at: string | null
          score_a: number | null
          score_b: number | null
          seed_a: number | null
          seed_b: number | null
          source_url: string | null
          status: Database["public"]["Enums"]["usau_game_status"]
          team_a_id: string | null
          team_a_placeholder: string | null
          team_b_id: string | null
          team_b_placeholder: string | null
          bracket_stage: string | null
          bracket_stage_index: number | null
          bracket_slot: number | null
          next_usau_game_id: string | null
          next_slot_side: string | null
          updated_at: string
          usau_event_game_id: string | null
          usau_game_id: string | null
          winner_team_id: string | null
        }
        Insert: {
          bracket_name?: string | null
          created_at?: string
          event_id: string
          id?: string
          location?: string | null
          played_at?: string | null
          round?: Database["public"]["Enums"]["usau_game_round"]
          scheduled_at?: string | null
          score_a?: number | null
          score_b?: number | null
          seed_a?: number | null
          seed_b?: number | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["usau_game_status"]
          team_a_id?: string | null
          team_a_placeholder?: string | null
          team_b_id?: string | null
          team_b_placeholder?: string | null
          bracket_stage?: string | null
          bracket_stage_index?: number | null
          bracket_slot?: number | null
          next_usau_game_id?: string | null
          next_slot_side?: string | null
          updated_at?: string
          usau_event_game_id?: string | null
          usau_game_id?: string | null
          winner_team_id?: string | null
        }
        Update: {
          bracket_name?: string | null
          created_at?: string
          event_id?: string
          id?: string
          location?: string | null
          played_at?: string | null
          round?: Database["public"]["Enums"]["usau_game_round"]
          scheduled_at?: string | null
          score_a?: number | null
          score_b?: number | null
          seed_a?: number | null
          seed_b?: number | null
          source_url?: string | null
          status?: Database["public"]["Enums"]["usau_game_status"]
          team_a_id?: string | null
          team_a_placeholder?: string | null
          team_b_id?: string | null
          team_b_placeholder?: string | null
          bracket_stage?: string | null
          bracket_stage_index?: number | null
          bracket_slot?: number | null
          next_usau_game_id?: string | null
          next_slot_side?: string | null
          updated_at?: string
          usau_event_game_id?: string | null
          usau_game_id?: string | null
          winner_team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usau_games_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "usau_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usau_games_team_a_id_fkey"
            columns: ["team_a_id"]
            isOneToOne: false
            referencedRelation: "usau_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usau_games_team_b_id_fkey"
            columns: ["team_b_id"]
            isOneToOne: false
            referencedRelation: "usau_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      usau_player_event_stats: {
        Row: {
          assists: number | null
          event_id: string
          goals: number | null
          player_id: string
          scraped_at: string
          team_id: string | null
        }
        Insert: {
          assists?: number | null
          event_id: string
          goals?: number | null
          player_id: string
          scraped_at?: string
          team_id?: string | null
        }
        Update: {
          assists?: number | null
          event_id?: string
          goals?: number | null
          player_id?: string
          scraped_at?: string
          team_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usau_player_event_stats_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "usau_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usau_player_event_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "usau_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usau_player_event_stats_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "usau_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      usau_players: {
        Row: {
          created_at: string
          display_name: string
          id: string
          usau_player_id: string | null
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          usau_player_id?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          usau_player_id?: string | null
        }
        Relationships: []
      }
      usau_rankings: {
        Row: {
          city: string | null
          conference: string | null
          division: string
          losses: number | null
          rank: number
          rating: number | null
          region: string | null
          scraped_at: string
          season: number
          state: string | null
          team_id: string | null
          team_name: string
          week: number
          wins: number | null
        }
        Insert: {
          city?: string | null
          conference?: string | null
          division: string
          losses?: number | null
          rank: number
          rating?: number | null
          region?: string | null
          scraped_at?: string
          season: number
          state?: string | null
          team_id?: string | null
          team_name: string
          week: number
          wins?: number | null
        }
        Update: {
          city?: string | null
          conference?: string | null
          division?: string
          losses?: number | null
          rank?: number
          rating?: number | null
          region?: string | null
          scraped_at?: string
          season?: number
          state?: string | null
          team_id?: string | null
          team_name?: string
          week?: number
          wins?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "usau_rankings_season_fkey"
            columns: ["season"]
            isOneToOne: false
            referencedRelation: "usau_seasons"
            referencedColumns: ["year"]
          },
          {
            foreignKeyName: "usau_rankings_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "usau_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      usau_rosters: {
        Row: {
          event_id: string | null
          jersey_number: string | null
          player_id: string
          season: number
          team_id: string
        }
        Insert: {
          event_id?: string | null
          jersey_number?: string | null
          player_id: string
          season: number
          team_id: string
        }
        Update: {
          event_id?: string | null
          jersey_number?: string | null
          player_id?: string
          season?: number
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usau_rosters_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "usau_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usau_rosters_season_fkey"
            columns: ["season"]
            isOneToOne: false
            referencedRelation: "usau_seasons"
            referencedColumns: ["year"]
          },
          {
            foreignKeyName: "usau_rosters_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "usau_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      usau_scrape_runs: {
        Row: {
          completed_at: string | null
          error: string | null
          id: string
          job_name: string
          metadata: Json | null
          rows_processed: number | null
          started_at: string
        }
        Insert: {
          completed_at?: string | null
          error?: string | null
          id?: string
          job_name: string
          metadata?: Json | null
          rows_processed?: number | null
          started_at?: string
        }
        Update: {
          completed_at?: string | null
          error?: string | null
          id?: string
          job_name?: string
          metadata?: Json | null
          rows_processed?: number | null
          started_at?: string
        }
        Relationships: []
      }
      usau_seasons: {
        Row: {
          is_active: boolean
          year: number
        }
        Insert: {
          is_active?: boolean
          year: number
        }
        Update: {
          is_active?: boolean
          year?: number
        }
        Relationships: []
      }
      usau_teams: {
        Row: {
          city: string | null
          competition_division: string | null
          competition_level:
            | Database["public"]["Enums"]["usau_competition_level"]
            | null
          created_at: string
          gender_division:
            | Database["public"]["Enums"]["usau_gender_division"]
            | null
          id: string
          last_scraped_at: string | null
          name: string
          school_or_club_name: string | null
          state: string | null
          team_designation: string | null
          updated_at: string
          usau_event_team_ids: string[]
          usau_team_id: string | null
        }
        Insert: {
          city?: string | null
          competition_division?: string | null
          competition_level?:
            | Database["public"]["Enums"]["usau_competition_level"]
            | null
          created_at?: string
          gender_division?:
            | Database["public"]["Enums"]["usau_gender_division"]
            | null
          id?: string
          last_scraped_at?: string | null
          name: string
          school_or_club_name?: string | null
          state?: string | null
          team_designation?: string | null
          updated_at?: string
          usau_event_team_ids?: string[]
          usau_team_id?: string | null
        }
        Update: {
          city?: string | null
          competition_division?: string | null
          competition_level?:
            | Database["public"]["Enums"]["usau_competition_level"]
            | null
          created_at?: string
          gender_division?:
            | Database["public"]["Enums"]["usau_gender_division"]
            | null
          id?: string
          last_scraped_at?: string | null
          name?: string
          school_or_club_name?: string | null
          state?: string | null
          team_designation?: string | null
          updated_at?: string
          usau_event_team_ids?: string[]
          usau_team_id?: string | null
        }
        Relationships: []
      }
      user_favorite_leagues: {
        Row: {
          created_at: string
          league: string
          user_id: string
        }
        Insert: {
          created_at?: string
          league: string
          user_id: string
        }
        Update: {
          created_at?: string
          league?: string
          user_id?: string
        }
        Relationships: []
      }
      user_favorite_players: {
        Row: {
          created_at: string
          headshot_url: string | null
          league: string
          name: string
          player_id: string
          team_name: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          headshot_url?: string | null
          league: string
          name: string
          player_id: string
          team_name?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          headshot_url?: string | null
          league?: string
          name?: string
          player_id?: string
          team_name?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_favorite_teams: {
        Row: {
          created_at: string
          league: string
          logo_url: string | null
          name: string
          team_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          league: string
          logo_url?: string | null
          name: string
          team_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          league?: string
          logo_url?: string | null
          name?: string
          team_id?: string
          user_id?: string
        }
        Relationships: []
      }
      utcg_draft_runs: {
        Row: {
          bank: number
          completed_at: string | null
          created_at: string
          deals: Json
          formation: string
          id: string
          payout: number | null
          picks: Json
          round: number
          slot_idx: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bank?: number
          completed_at?: string | null
          created_at?: string
          deals?: Json
          formation: string
          id?: string
          payout?: number | null
          picks?: Json
          round?: number
          slot_idx?: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bank?: number
          completed_at?: string | null
          created_at?: string
          deals?: Json
          formation?: string
          id?: string
          payout?: number | null
          picks?: Json
          round?: number
          slot_idx?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      utcg_listings: {
        Row: {
          ask_price: number | null
          closed_at: string | null
          created_at: string
          id: string
          kind: string
          league: string
          player_id: string
          seller_id: string
          status: string
          team_slug: string
          updated_at: string
          year: number
        }
        Insert: {
          ask_price?: number | null
          closed_at?: string | null
          created_at?: string
          id?: string
          kind: string
          league?: string
          player_id: string
          seller_id: string
          status?: string
          team_slug: string
          updated_at?: string
          year: number
        }
        Update: {
          ask_price?: number | null
          closed_at?: string | null
          created_at?: string
          id?: string
          kind?: string
          league?: string
          player_id?: string
          seller_id?: string
          status?: string
          team_slug?: string
          updated_at?: string
          year?: number
        }
        Relationships: []
      }
      utcg_owned_cards: {
        Row: {
          copies: number
          first_acquired_at: string
          league: string
          player_id: string
          team_slug: string
          user_id: string
          year: number
        }
        Insert: {
          copies?: number
          first_acquired_at?: string
          league?: string
          player_id: string
          team_slug: string
          user_id: string
          year: number
        }
        Update: {
          copies?: number
          first_acquired_at?: string
          league?: string
          player_id?: string
          team_slug?: string
          user_id?: string
          year?: number
        }
        Relationships: []
      }
      utcg_pack_openings: {
        Row: {
          coins_spent: number
          id: number
          opened_at: string
          pack_kind: string
          pulls: Json
          user_id: string
        }
        Insert: {
          coins_spent?: number
          id?: never
          opened_at?: string
          pack_kind: string
          pulls: Json
          user_id: string
        }
        Update: {
          coins_spent?: number
          id?: never
          opened_at?: string
          pack_kind?: string
          pulls?: Json
          user_id?: string
        }
        Relationships: []
      }
      utcg_pvp_matches: {
        Row: {
          challenger_chem: number
          challenger_id: string
          challenger_strength: number
          created_at: string
          decided_by: string
          defender_chem: number
          defender_id: string
          defender_strength: number
          id: string
          outcome: string
          pot: number
        }
        Insert: {
          challenger_chem: number
          challenger_id: string
          challenger_strength: number
          created_at?: string
          decided_by: string
          defender_chem: number
          defender_id: string
          defender_strength: number
          id?: string
          outcome: string
          pot: number
        }
        Update: {
          challenger_chem?: number
          challenger_id?: string
          challenger_strength?: number
          created_at?: string
          decided_by?: string
          defender_chem?: number
          defender_id?: string
          defender_strength?: number
          id?: string
          outcome?: string
          pot?: number
        }
        Relationships: []
      }
      utcg_pvp_squads: {
        Row: {
          cards: Json
          chem: number
          consumed_at: string | null
          created_at: string
          formation: string
          id: string
          mean_score: number
          staked_coins: number
          strength: number
          user_id: string
        }
        Insert: {
          cards: Json
          chem: number
          consumed_at?: string | null
          created_at?: string
          formation: string
          id?: string
          mean_score: number
          staked_coins?: number
          strength: number
          user_id: string
        }
        Update: {
          cards?: Json
          chem?: number
          consumed_at?: string | null
          created_at?: string
          formation?: string
          id?: string
          mean_score?: number
          staked_coins?: number
          strength?: number
          user_id?: string
        }
        Relationships: []
      }
      utcg_trade_offer_cards: {
        Row: {
          id: string
          league: string
          offer_id: string
          player_id: string
          qty: number
          team_slug: string
          year: number
        }
        Insert: {
          id?: string
          league?: string
          offer_id: string
          player_id: string
          qty?: number
          team_slug: string
          year: number
        }
        Update: {
          id?: string
          league?: string
          offer_id?: string
          player_id?: string
          qty?: number
          team_slug?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "utcg_trade_offer_cards_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "utcg_trade_offers"
            referencedColumns: ["id"]
          },
        ]
      }
      utcg_trade_offers: {
        Row: {
          created_at: string
          id: string
          listing_id: string
          offer_coins: number
          offerer_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          listing_id: string
          offer_coins?: number
          offerer_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          listing_id?: string
          offer_coins?: number
          offerer_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "utcg_trade_offers_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "utcg_listings"
            referencedColumns: ["id"]
          },
        ]
      }
      utcg_wallets: {
        Row: {
          best_wins: number
          coins: number
          created_at: string
          last_free_pack_at: string | null
          matches_day: string | null
          matches_played: number
          matches_today: number
          packs_opened: number
          updated_at: string
          user_id: string
        }
        Insert: {
          best_wins?: number
          coins?: number
          created_at?: string
          last_free_pack_at?: string | null
          matches_day?: string | null
          matches_played?: number
          matches_today?: number
          packs_opened?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          best_wins?: number
          coins?: number
          created_at?: string
          last_free_pack_at?: string | null
          matches_day?: string | null
          matches_played?: number
          matches_today?: number
          packs_opened?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      wfdf_divisions: {
        Row: {
          created_at: string
          event_id: string
          id: string
          name: string
          ordering: string | null
          wfdf_series_id: number
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          name: string
          ordering?: string | null
          wfdf_series_id: number
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          name?: string
          ordering?: string | null
          wfdf_series_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "wfdf_divisions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "wfdf_events"
            referencedColumns: ["id"]
          },
        ]
      }
      wfdf_events: {
        Row: {
          created_at: string
          end_date: string | null
          id: string
          is_national_teams: boolean
          kind: Database["public"]["Enums"]["wfdf_event_kind"]
          last_scraped_at: string | null
          last_scraped_status: string | null
          location: string | null
          logo_url: string | null
          name: string
          season_id: string
          short_name: string | null
          slug: string
          source_origin: string | null
          start_date: string | null
          static_base: string | null
          updated_at: string
          year: number
        }
        Insert: {
          created_at?: string
          end_date?: string | null
          id?: string
          is_national_teams?: boolean
          kind?: Database["public"]["Enums"]["wfdf_event_kind"]
          last_scraped_at?: string | null
          last_scraped_status?: string | null
          location?: string | null
          logo_url?: string | null
          name: string
          season_id: string
          short_name?: string | null
          slug: string
          source_origin?: string | null
          start_date?: string | null
          static_base?: string | null
          updated_at?: string
          year: number
        }
        Update: {
          created_at?: string
          end_date?: string | null
          id?: string
          is_national_teams?: boolean
          kind?: Database["public"]["Enums"]["wfdf_event_kind"]
          last_scraped_at?: string | null
          last_scraped_status?: string | null
          location?: string | null
          logo_url?: string | null
          name?: string
          season_id?: string
          short_name?: string | null
          slug?: string
          source_origin?: string | null
          start_date?: string | null
          static_base?: string | null
          updated_at?: string
          year?: number
        }
        Relationships: []
      }
      wfdf_game_goals: {
        Row: {
          assist_wfdf_player_id: number | null
          away_score: number
          created_at: string
          event_id: string
          game_id: string
          home_score: number
          id: string
          is_callahan: boolean
          is_home_goal: boolean
          num: number
          scored_at: string | null
          scorer_wfdf_player_id: number | null
          time_s: number | null
        }
        Insert: {
          assist_wfdf_player_id?: number | null
          away_score: number
          created_at?: string
          event_id: string
          game_id: string
          home_score: number
          id?: string
          is_callahan?: boolean
          is_home_goal: boolean
          num: number
          scored_at?: string | null
          scorer_wfdf_player_id?: number | null
          time_s?: number | null
        }
        Update: {
          assist_wfdf_player_id?: number | null
          away_score?: number
          created_at?: string
          event_id?: string
          game_id?: string
          home_score?: number
          id?: string
          is_callahan?: boolean
          is_home_goal?: boolean
          num?: number
          scored_at?: string | null
          scorer_wfdf_player_id?: number | null
          time_s?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "wfdf_game_goals_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "wfdf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_game_goals_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "wfdf_games"
            referencedColumns: ["id"]
          },
        ]
      }
      wfdf_game_player_stats: {
        Row: {
          assists: number
          callahans: number
          created_at: string
          event_id: string
          game_id: string
          goals: number
          id: string
          jersey_number: string | null
          team_id: string | null
          total: number
          wfdf_player_id: number
        }
        Insert: {
          assists?: number
          callahans?: number
          created_at?: string
          event_id: string
          game_id: string
          goals?: number
          id?: string
          jersey_number?: string | null
          team_id?: string | null
          total?: number
          wfdf_player_id: number
        }
        Update: {
          assists?: number
          callahans?: number
          created_at?: string
          event_id?: string
          game_id?: string
          goals?: number
          id?: string
          jersey_number?: string | null
          team_id?: string | null
          total?: number
          wfdf_player_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "wfdf_game_player_stats_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "wfdf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_game_player_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "wfdf_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_game_player_stats_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "wfdf_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      wfdf_games: {
        Row: {
          away_scheduling_name: string | null
          away_scheduling_pool: string | null
          away_score: number | null
          away_sotg: number | null
          away_team_id: string | null
          created_at: string
          detail_synced_at: string | null
          division_id: string | null
          event_id: string
          field_name: string | null
          goals_count: number | null
          home_scheduling_name: string | null
          home_scheduling_pool: string | null
          home_score: number | null
          home_sotg: number | null
          home_team_id: string | null
          id: string
          is_bracket: boolean
          pool_name: string | null
          scheduled_at: string | null
          status: Database["public"]["Enums"]["wfdf_game_status"]
          updated_at: string
          wfdf_game_id: number
        }
        Insert: {
          away_scheduling_name?: string | null
          away_scheduling_pool?: string | null
          away_score?: number | null
          away_sotg?: number | null
          away_team_id?: string | null
          created_at?: string
          detail_synced_at?: string | null
          division_id?: string | null
          event_id: string
          field_name?: string | null
          goals_count?: number | null
          home_scheduling_name?: string | null
          home_scheduling_pool?: string | null
          home_score?: number | null
          home_sotg?: number | null
          home_team_id?: string | null
          id?: string
          is_bracket?: boolean
          pool_name?: string | null
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["wfdf_game_status"]
          updated_at?: string
          wfdf_game_id: number
        }
        Update: {
          away_scheduling_name?: string | null
          away_scheduling_pool?: string | null
          away_score?: number | null
          away_sotg?: number | null
          away_team_id?: string | null
          created_at?: string
          detail_synced_at?: string | null
          division_id?: string | null
          event_id?: string
          field_name?: string | null
          goals_count?: number | null
          home_scheduling_name?: string | null
          home_scheduling_pool?: string | null
          home_score?: number | null
          home_sotg?: number | null
          home_team_id?: string | null
          id?: string
          is_bracket?: boolean
          pool_name?: string | null
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["wfdf_game_status"]
          updated_at?: string
          wfdf_game_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "wfdf_games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "wfdf_teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_games_division_id_fkey"
            columns: ["division_id"]
            isOneToOne: false
            referencedRelation: "wfdf_divisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_games_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "wfdf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "wfdf_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      wfdf_rosters: {
        Row: {
          assists: number | null
          callahans: number | null
          created_at: string
          event_id: string
          first_name: string | null
          full_name: string
          games: number | null
          goals: number | null
          id: string
          jersey_number: string | null
          last_name: string | null
          team_id: string
          total: number | null
          wfdf_player_id: number
        }
        Insert: {
          assists?: number | null
          callahans?: number | null
          created_at?: string
          event_id: string
          first_name?: string | null
          full_name: string
          games?: number | null
          goals?: number | null
          id?: string
          jersey_number?: string | null
          last_name?: string | null
          team_id: string
          total?: number | null
          wfdf_player_id: number
        }
        Update: {
          assists?: number | null
          callahans?: number | null
          created_at?: string
          event_id?: string
          first_name?: string | null
          full_name?: string
          games?: number | null
          goals?: number | null
          id?: string
          jersey_number?: string | null
          last_name?: string | null
          team_id?: string
          total?: number | null
          wfdf_player_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "wfdf_rosters_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "wfdf_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_rosters_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "wfdf_teams"
            referencedColumns: ["id"]
          },
        ]
      }
      wfdf_teams: {
        Row: {
          abbreviation: string | null
          club_name: string | null
          country_code: string | null
          country_name: string | null
          created_at: string
          division_id: string | null
          event_id: string
          final_standing: number | null
          flag_file: string | null
          games: number | null
          id: string
          losses: number | null
          name: string
          scores_against: number | null
          scores_for: number | null
          seed: number | null
          spirit_avg: number | null
          updated_at: string
          wfdf_team_id: number
          wins: number | null
        }
        Insert: {
          abbreviation?: string | null
          club_name?: string | null
          country_code?: string | null
          country_name?: string | null
          created_at?: string
          division_id?: string | null
          event_id: string
          final_standing?: number | null
          flag_file?: string | null
          games?: number | null
          id?: string
          losses?: number | null
          name: string
          scores_against?: number | null
          scores_for?: number | null
          seed?: number | null
          spirit_avg?: number | null
          updated_at?: string
          wfdf_team_id: number
          wins?: number | null
        }
        Update: {
          abbreviation?: string | null
          club_name?: string | null
          country_code?: string | null
          country_name?: string | null
          created_at?: string
          division_id?: string | null
          event_id?: string
          final_standing?: number | null
          flag_file?: string | null
          games?: number | null
          id?: string
          losses?: number | null
          name?: string
          scores_against?: number | null
          scores_for?: number | null
          seed?: number | null
          spirit_avg?: number | null
          updated_at?: string
          wfdf_team_id?: number
          wins?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "wfdf_teams_division_id_fkey"
            columns: ["division_id"]
            isOneToOne: false
            referencedRelation: "wfdf_divisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wfdf_teams_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "wfdf_events"
            referencedColumns: ["id"]
          },
        ]
      }
      wul_game_player_stats: {
        Row: {
          assists: number
          blocks: number
          callahans: number
          completions: number
          created_at: string
          d_points: number
          game_id: string
          goals: number
          hucks_completed: number
          id: string
          jersey_number: string | null
          o_points: number
          player_name: string
          plus_minus: number
          points_played: number
          receive_yards: number
          team_id: string
          throw_yards: number
          throws: number
          total_yards: number
          touches: number
          turnovers: number
          updated_at: string
        }
        Insert: {
          assists?: number
          blocks?: number
          callahans?: number
          completions?: number
          created_at?: string
          d_points?: number
          game_id: string
          goals?: number
          hucks_completed?: number
          id?: string
          jersey_number?: string | null
          o_points?: number
          player_name: string
          plus_minus?: number
          points_played?: number
          receive_yards?: number
          team_id: string
          throw_yards?: number
          throws?: number
          total_yards?: number
          touches?: number
          turnovers?: number
          updated_at?: string
        }
        Update: {
          assists?: number
          blocks?: number
          callahans?: number
          completions?: number
          created_at?: string
          d_points?: number
          game_id?: string
          goals?: number
          hucks_completed?: number
          id?: string
          jersey_number?: string | null
          o_points?: number
          player_name?: string
          plus_minus?: number
          points_played?: number
          receive_yards?: number
          team_id?: string
          throw_yards?: number
          throws?: number
          total_yards?: number
          touches?: number
          turnovers?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wul_game_player_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "wul_games"
            referencedColumns: ["id"]
          },
        ]
      }
      wul_games: {
        Row: {
          away_abbrev: string
          away_score: number | null
          away_team_id: string
          created_at: string
          game_date: string | null
          game_time: string | null
          home_abbrev: string
          home_score: number | null
          home_team_id: string
          id: string
          season: number
          status: string
          updated_at: string
          week_label: string
        }
        Insert: {
          away_abbrev: string
          away_score?: number | null
          away_team_id: string
          created_at?: string
          game_date?: string | null
          game_time?: string | null
          home_abbrev: string
          home_score?: number | null
          home_team_id: string
          id: string
          season: number
          status?: string
          updated_at?: string
          week_label: string
        }
        Update: {
          away_abbrev?: string
          away_score?: number | null
          away_team_id?: string
          created_at?: string
          game_date?: string | null
          game_time?: string | null
          home_abbrev?: string
          home_score?: number | null
          home_team_id?: string
          id?: string
          season?: number
          status?: string
          updated_at?: string
          week_label?: string
        }
        Relationships: []
      }
      wul_players: {
        Row: {
          assists: number
          blocks: number
          callahans: number
          created_at: string
          d_points: number
          games_played: number
          goals: number
          hucks_completed: number
          id: string
          jersey_number: string
          o_points: number
          player_name: string
          plus_minus: number
          season: number
          team_id: string
          touches: number
          turnovers: number
          updated_at: string
          yards_total: number
        }
        Insert: {
          assists?: number
          blocks?: number
          callahans?: number
          created_at?: string
          d_points?: number
          games_played?: number
          goals?: number
          hucks_completed?: number
          id?: string
          jersey_number?: string
          o_points?: number
          player_name: string
          plus_minus?: number
          season: number
          team_id: string
          touches?: number
          turnovers?: number
          updated_at?: string
          yards_total?: number
        }
        Update: {
          assists?: number
          blocks?: number
          callahans?: number
          created_at?: string
          d_points?: number
          games_played?: number
          goals?: number
          hucks_completed?: number
          id?: string
          jersey_number?: string
          o_points?: number
          player_name?: string
          plus_minus?: number
          season?: number
          team_id?: string
          touches?: number
          turnovers?: number
          updated_at?: string
          yards_total?: number
        }
        Relationships: []
      }
      wul_teams: {
        Row: {
          abbr: string | null
          accent_color: string | null
          city: string
          created_at: string
          id: string
          logo_url: string | null
          mascot: string
          name: string
          updated_at: string
        }
        Insert: {
          abbr?: string | null
          accent_color?: string | null
          city: string
          created_at?: string
          id: string
          logo_url?: string | null
          mascot: string
          name: string
          updated_at?: string
        }
        Update: {
          abbr?: string | null
          accent_color?: string | null
          city?: string
          created_at?: string
          id?: string
          logo_url?: string | null
          mascot?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      cron_health: {
        Row: {
          active: boolean | null
          failed_24h: number | null
          failed_7d: number | null
          jobid: number | null
          jobname: string | null
          last_failure_msg: string | null
          last_run_at: string | null
          last_success_at: string | null
          runs_24h: number | null
          schedule: string | null
        }
        Relationships: []
      }
      profile_contact: {
        Row: {
          email: string | null
          id: string | null
          phone: string | null
        }
        Insert: {
          email?: string | null
          id?: string | null
          phone?: string | null
        }
        Update: {
          email?: string | null
          id?: string | null
          phone?: string | null
        }
        Relationships: []
      }
      profiles_public: {
        Row: {
          avatar_url: string | null
          display_name: string | null
          id: string | null
          username: string | null
        }
        Insert: {
          avatar_url?: string | null
          display_name?: string | null
          id?: string | null
          username?: string | null
        }
        Update: {
          avatar_url?: string | null
          display_name?: string | null
          id?: string | null
          username?: string | null
        }
        Relationships: []
      }
      twelve_oh_team_years: {
        Row: {
          league: string | null
          player_count: number | null
          team_abbr: string | null
          team_slug: string | null
          year: number | null
        }
        Relationships: []
      }
      usau_event_feed: {
        Row: {
          end_date: string | null
          event_id: string | null
          flight_rank: number | null
          group_count: number | null
          has_games: boolean | null
          key: string | null
          kind: string | null
          kind_rank: number | null
          level: Database["public"]["Enums"]["usau_competition_level"] | null
          name: string | null
          season: number | null
          series_stage: string | null
          sort_date: string | null
          start_date: string | null
        }
        Relationships: []
      }
      usau_player_prestige: {
        Row: {
          played_nats: boolean | null
          player_id: string | null
          won_nats: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "usau_rosters_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "usau_players"
            referencedColumns: ["id"]
          },
        ]
      }
      utcg_card_pool: {
        Row: {
          division: string | null
          name: string | null
          player_id: string | null
          position: string | null
          score: number | null
          team_abbr: string | null
          team_slug: string | null
          tier_rank: number | null
          year: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      _build_player_profile: { Args: { p_anchor_id: string }; Returns: Json }
      _rebuild_and_cache_player_profile: {
        Args: { p_anchor_id: string }
        Returns: Json
      }
      accept_team_invite: {
        Args: { p_token: string }
        Returns: {
          role: Database["public"]["Enums"]["pb_team_role"]
          team_id: string
          team_name: string
        }[]
      }
      admin_list_users: {
        Args: never
        Returns: {
          created_at: string
          display_name: string
          email: string
          id: string
          role: string
          username: string
        }[]
      }
      can_edit_play: { Args: { p_play_id: string }; Returns: boolean }
      can_view_play: { Args: { p_play_id: string }; Returns: boolean }
      check_cron_health: {
        Args: { p_window?: string }
        Returns: {
          detail: string
          failure_class: string
          failures: number
          jobid: number
          jobname: string
        }[]
      }
      compact_name_key: { Args: { p: string }; Returns: string }
      create_team_invite: {
        Args: {
          p_email: string
          p_role?: Database["public"]["Enums"]["pb_team_role"]
          p_team_id: string
        }
        Returns: {
          expires_at: string
          token: string
        }[]
      }
      derive_euf_placements: { Args: { p_event_id?: string }; Returns: number }
      distinct_usau_seasons: {
        Args: never
        Returns: {
          season: number
        }[]
      }
      fantasy_accept_league_invite: {
        Args: { p_token: string }
        Returns: string
      }
      fantasy_carry_over_rosters: {
        Args: { p_year?: number }
        Returns: {
          from_week: string
          into_week: string
          slots_copied: number
          team_id: string
        }[]
      }
      fantasy_create_league: { Args: { p_name: string }; Returns: string }
      fantasy_create_league_invite: {
        Args: { p_email: string; p_league: string }
        Returns: {
          expires_at: string
          token: string
        }[]
      }
      fantasy_get_league_code: { Args: { p_league: string }; Returns: string }
      fantasy_handle_available: { Args: { p_handle: string }; Returns: boolean }
      fantasy_is_commissioner: { Args: { p_league: string }; Returns: boolean }
      fantasy_is_league_member: { Args: { p_league: string }; Returns: boolean }
      fantasy_join_league: { Args: { p_code: string }; Returns: string }
      fantasy_leave_league: { Args: { p_league: string }; Returns: undefined }
      fantasy_owns_team: { Args: { t_id: string }; Returns: boolean }
      fantasy_preview_league_invite: {
        Args: { p_token: string }
        Returns: {
          email: string
          league_name: string
        }[]
      }
      fantasy_rebuild_all_periods: { Args: never; Returns: undefined }
      fantasy_rebuild_contest_periods: {
        Args: { p_contest: string }
        Returns: undefined
      }
      fantasy_regenerate_league_code: {
        Args: { p_league: string }
        Returns: string
      }
      fantasy_remove_league_member: {
        Args: { p_league: string; p_user: string }
        Returns: undefined
      }
      fantasy_roster_is_valid: {
        Args: { t_id: string; wk: string }
        Returns: boolean
      }
      find_usau_player_by_name: { Args: { p_name: string }; Returns: string }
      get_euf_club_cross_league: {
        Args: { p_division: string; p_name: string }
        Returns: {
          country_name: string
          division: string
          event_name: string
          event_slug: string
          league: string
          placement: number
          ref_id: string
          team_name: string
          year: number
        }[]
      }
      get_euf_club_profile: {
        Args: { p_division: string; p_name: string }
        Returns: {
          club_key: string
          club_name: string
          country_name: string
          division: string
          event_id: string
          event_name: string
          event_slug: string
          final_placement: number
          games: number
          kind: string
          losses: number
          scores_against: number
          scores_for: number
          team_id: string
          wins: number
          year: number
        }[]
      }
      get_euf_player_profile: {
        Args: { p_name: string }
        Returns: {
          assists: number
          country_name: string
          division: Database["public"]["Enums"]["euf_division"]
          event_id: string
          event_name: string
          event_slug: string
          final_placement: number
          full_name: string
          games: number
          goals: number
          jersey_number: string
          team_id: string
          team_name: string
          total: number
          year: number
        }[]
      }
      get_euf_standings: {
        Args: { p_event_slug: string }
        Returns: {
          country_name: string
          division: Database["public"]["Enums"]["euf_division"]
          final_placement: number
          games: number
          losses: number
          point_diff: number
          scores_against: number
          scores_for: number
          team_id: string
          team_name: string
          wins: number
        }[]
      }
      get_player_connections: {
        Args: { p_limit?: number; p_name: string }
        Returns: {
          bridge_count: number
          display_name: string
          is_alumni: boolean
          is_nationals: boolean
          is_pro: boolean
          leagues: string[]
          name: string
          score: number
          usau_id: string
          via_display: string
        }[]
      }
      get_player_profile: { Args: { p_anchor_id: string }; Returns: Json }
      get_player_thread: {
        Args: { p_conns?: number; p_name: string; p_teammates?: number }
        Returns: Json
      }
      is_admin: { Args: never; Returns: boolean }
      is_team_editor: { Args: { p_team_id: string }; Returns: boolean }
      is_team_member: { Args: { p_team_id: string }; Returns: boolean }
      jersey_is_blocked: {
        Args: { p_a: string; p_b: string }
        Returns: boolean
      }
      jersey_is_thread_participant: {
        Args: { p_thread: string; p_user: string }
        Returns: boolean
      }
      jersey_text_is_clean: { Args: { p_text: string }; Returns: boolean }
      jersey_thread_messages_for_admin: {
        Args: { p_thread: string }
        Returns: {
          body: string
          created_at: string
          id: string
          sender_id: string
        }[]
      }
      list_euf_clubs: {
        Args: never
        Returns: {
          appearances: number
          best_placement: number
          club_key: string
          club_name: string
          country_name: string
          division: string
          events: number
          first_year: number
          last_year: number
        }[]
      }
      list_euf_top_players: {
        Args: { lim?: number }
        Returns: {
          assists: number
          country_name: string
          division: string
          events: number
          full_name: string
          goals: number
          points: number
          team_name: string
        }[]
      }
      list_usau_players: {
        Args: {
          p_champions?: Json
          p_division?: string
          p_level?: string
          p_limit?: number
          p_search?: string
          p_season?: number
        }
        Returns: Json
      }
      name_search_rank: { Args: { name: string; q: string }; Returns: number }
      names_match: { Args: { a: string; b: string }; Returns: boolean }
      normalize_player_name: { Args: { p: string }; Returns: string }
      preview_team_invite: {
        Args: { p_token: string }
        Returns: {
          email: string
          team_name: string
        }[]
      }
      rebuild_player_edges: {
        Args: never
        Returns: {
          edges: number
          nodes: number
        }[]
      }
      search_euf_events_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          id: string
          kind: string
          location: string
          name: string
          score: number
          slug: string
          year: number
        }[]
      }
      search_euf_players_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          country_name: string
          event_name: string
          event_slug: string
          full_name: string
          score: number
          team_id: string
          team_name: string
        }[]
      }
      search_euf_teams_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          country_name: string
          division: string
          event_name: string
          event_slug: string
          id: string
          name: string
          score: number
          year: number
        }[]
      }
      search_pul_players_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          id: string
          player_name: string
          score: number
          season: number
          team_id: string
          team_name: string
        }[]
      }
      search_ufa_players_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          current_team_id: string
          full_name: string
          id: string
          score: number
        }[]
      }
      search_usau_events_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          end_date: string
          name: string
          score: number
          season: number
          start_date: string
          usau_slug: string
        }[]
      }
      search_usau_players_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          display_name: string
          id: string
          prestige: number
          score: number
        }[]
      }
      search_usau_teams_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          competition_level: string
          gender_division: string
          id: string
          name: string
          score: number
          state: string
        }[]
      }
      search_wfdf_events_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          name: string
          score: number
          slug: string
          year: number
        }[]
      }
      search_wfdf_players_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          country_code: string
          event_name: string
          full_name: string
          score: number
          team_id: string
          team_name: string
        }[]
      }
      search_wfdf_teams_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          country_code: string
          event_name: string
          id: string
          name: string
          score: number
        }[]
      }
      search_wul_players_fuzzy: {
        Args: { lim?: number; q: string }
        Returns: {
          id: string
          player_name: string
          score: number
          season: number
          team_id: string
          team_name: string
        }[]
      }
      set_user_role: {
        Args: { p_role: string; p_user_id: string }
        Returns: undefined
      }
      top_usau_club_teams: {
        Args: { p_gender_division?: string; p_limit?: number }
        Returns: {
          id: string
          name: string
          nationals_placement: number
        }[]
      }
      trickle_rebuild_player_profiles: {
        Args: { p_limit?: number }
        Returns: number
      }
      ufa_complete_stat_game_ids: {
        Args: { p_ids: string[] }
        Returns: {
          game_id: string
        }[]
      }
      unaccent_safe: { Args: { p: string }; Returns: string }
      usau_states_for_event_name: {
        Args: { p_name: string }
        Returns: string[]
      }
      utcg_derive_position: {
        Args: {
          assists: number
          goals: number
          yards_received: number
          yards_thrown: number
        }
        Returns: string
      }
      utcg_draft_abandon: { Args: { p_run_id: string }; Returns: Json }
      utcg_draft_deal: {
        Args: { p_exclude_players: string[]; p_slot: string }
        Returns: Json
      }
      utcg_draft_pick: {
        Args: { p_index: number; p_run_id: string }
        Returns: Json
      }
      utcg_draft_play: { Args: { p_run_id: string }; Returns: Json }
      utcg_draft_start: { Args: { p_formation: string }; Returns: Json }
      utcg_ensure_wallet: {
        Args: never
        Returns: {
          best_wins: number
          coins: number
          created_at: string
          last_free_pack_at: string | null
          matches_day: string | null
          matches_played: number
          matches_today: number
          packs_opened: number
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "utcg_wallets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      utcg_eval_lineup: {
        Args: { p_formation: string; p_players: Json }
        Returns: Json
      }
      utcg_formation_slots: { Args: { p_formation: string }; Returns: string[] }
      utcg_market_accept_offer: {
        Args: { p_offer_id: string }
        Returns: undefined
      }
      utcg_market_buy: {
        Args: { p_listing_id: string }
        Returns: {
          best_wins: number
          coins: number
          created_at: string
          last_free_pack_at: string | null
          matches_day: string | null
          matches_played: number
          matches_today: number
          packs_opened: number
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "utcg_wallets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      utcg_market_cancel: { Args: { p_listing_id: string }; Returns: undefined }
      utcg_market_decline_offer: {
        Args: { p_offer_id: string }
        Returns: undefined
      }
      utcg_market_grant_card: {
        Args: {
          p_league: string
          p_player_id: string
          p_qty: number
          p_team_slug: string
          p_user: string
          p_year: number
        }
        Returns: undefined
      }
      utcg_market_list: {
        Args: {
          p_ask_price?: number
          p_kind: string
          p_player_id: string
          p_team_slug: string
          p_year: number
        }
        Returns: {
          ask_price: number | null
          closed_at: string | null
          created_at: string
          id: string
          kind: string
          league: string
          player_id: string
          seller_id: string
          status: string
          team_slug: string
          updated_at: string
          year: number
        }
        SetofOptions: {
          from: "*"
          to: "utcg_listings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      utcg_market_make_offer: {
        Args: { p_cards: Json; p_coins?: number; p_listing_id: string }
        Returns: {
          created_at: string
          id: string
          listing_id: string
          offer_coins: number
          offerer_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "utcg_trade_offers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      utcg_market_refund_offer: {
        Args: { p_offer_id: string }
        Returns: undefined
      }
      utcg_market_take_card: {
        Args: {
          p_league: string
          p_player_id: string
          p_qty: number
          p_team_slug: string
          p_user: string
          p_year: number
        }
        Returns: undefined
      }
      utcg_market_withdraw_offer: {
        Args: { p_offer_id: string }
        Returns: undefined
      }
      utcg_open_pack: { Args: { p_kind: string }; Returns: Json }
      utcg_pack_config: {
        Args: { p_kind: string }
        Returns: {
          guarantee_rank: number
          price: number
          size: number
          w_contributor: number
          w_elite: number
          w_fringe: number
          w_greatest: number
          w_leagueavg: number
          w_solidpro: number
          w_star: number
        }[]
      }
      utcg_pvp_cancel: { Args: never; Returns: Json }
      utcg_pvp_enter: {
        Args: { p_cards: Json; p_formation: string }
        Returns: Json
      }
      utcg_quicksell: {
        Args: {
          p_player_id: string
          p_qty?: number
          p_team_slug: string
          p_year: number
        }
        Returns: {
          best_wins: number
          coins: number
          created_at: string
          last_free_pack_at: string | null
          matches_day: string | null
          matches_played: number
          matches_today: number
          packs_opened: number
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "utcg_wallets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      utcg_quicksell_value: { Args: { rank: number }; Returns: number }
      utcg_record_match: {
        Args: { p_cards: Json; p_formation: string }
        Returns: Json
      }
      utcg_tier_rank: { Args: { score: number }; Returns: number }
      utcg_ufa_division: { Args: { slug: string }; Returns: string }
    }
    Enums: {
      euf_division: "Open" | "Women's" | "Mixed"
      euf_event_kind:
        | "eucf"
        | "e2cf"
        | "elite_invite"
        | "spring_tour"
        | "summer_tour"
        | "regional"
        | "other"
      euf_game_stage:
        | "pool"
        | "crossover"
        | "bracket"
        | "quarterfinal"
        | "semifinal"
        | "final"
        | "placement"
        | "other"
      euf_game_status: "scheduled" | "completed" | "forfeit" | "cancelled"
      feedback_status: "new" | "read" | "resolved"
      jersey_condition: "new" | "excellent" | "good" | "worn"
      jersey_listing_kind: "trade" | "sell" | "both"
      jersey_listing_status: "active" | "completed" | "withdrawn"
      jersey_report_status: "new" | "reviewed" | "actioned" | "dismissed"
      pb_team_role: "owner" | "coach" | "member"
      player_content_kind: "image" | "video" | "video_link" | "link"
      player_content_report_status: "new" | "resolved"
      player_content_status: "pending" | "approved" | "rejected"
      usau_competition_level:
        | "CLUB"
        | "COLLEGE_D1"
        | "COLLEGE_D3"
        | "HS"
        | "MS"
        | "YC"
        | "MASTERS"
        | "GRAND_MASTERS"
        | "BEACH"
        | "OTHER"
        | "GREAT_GRAND_MASTERS"
      usau_event_type:
        | "regular_season"
        | "sectional"
        | "regional"
        | "national"
        | "masters"
        | "youth_club"
        | "beach"
        | "pro"
        | "unaffiliated"
        | "other"
      usau_game_round:
        | "pool"
        | "prequarter"
        | "quarter"
        | "semi"
        | "final"
        | "placement"
        | "consolation"
        | "other"
      usau_game_status:
        | "scheduled"
        | "in_progress"
        | "final"
        | "forfeit"
        | "cancelled"
      usau_gender_division: "Men" | "Women" | "Mixed" | "Open"
      user_role: "user" | "admin"
      wfdf_event_kind:
        | "club"
        | "national"
        | "beach"
        | "junior"
        | "u24"
        | "masters"
        | "other"
      wfdf_game_status:
        | "scheduled"
        | "in_progress"
        | "completed"
        | "forfeit"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      euf_division: ["Open", "Women's", "Mixed"],
      euf_event_kind: [
        "eucf",
        "e2cf",
        "elite_invite",
        "spring_tour",
        "summer_tour",
        "regional",
        "other",
      ],
      euf_game_stage: [
        "pool",
        "crossover",
        "bracket",
        "quarterfinal",
        "semifinal",
        "final",
        "placement",
        "other",
      ],
      euf_game_status: ["scheduled", "completed", "forfeit", "cancelled"],
      feedback_status: ["new", "read", "resolved"],
      jersey_condition: ["new", "excellent", "good", "worn"],
      jersey_listing_kind: ["trade", "sell", "both"],
      jersey_listing_status: ["active", "completed", "withdrawn"],
      jersey_report_status: ["new", "reviewed", "actioned", "dismissed"],
      pb_team_role: ["owner", "coach", "member"],
      player_content_kind: ["image", "video", "video_link", "link"],
      player_content_report_status: ["new", "resolved"],
      player_content_status: ["pending", "approved", "rejected"],
      usau_competition_level: [
        "CLUB",
        "COLLEGE_D1",
        "COLLEGE_D3",
        "HS",
        "MS",
        "YC",
        "MASTERS",
        "GRAND_MASTERS",
        "BEACH",
        "OTHER",
        "GREAT_GRAND_MASTERS",
      ],
      usau_event_type: [
        "regular_season",
        "sectional",
        "regional",
        "national",
        "masters",
        "youth_club",
        "beach",
        "pro",
        "unaffiliated",
        "other",
      ],
      usau_game_round: [
        "pool",
        "prequarter",
        "quarter",
        "semi",
        "final",
        "placement",
        "consolation",
        "other",
      ],
      usau_game_status: [
        "scheduled",
        "in_progress",
        "final",
        "forfeit",
        "cancelled",
      ],
      usau_gender_division: ["Men", "Women", "Mixed", "Open"],
      user_role: ["user", "admin"],
      wfdf_event_kind: [
        "club",
        "national",
        "beach",
        "junior",
        "u24",
        "masters",
        "other",
      ],
      wfdf_game_status: [
        "scheduled",
        "in_progress",
        "completed",
        "forfeit",
        "cancelled",
      ],
    },
  },
} as const
