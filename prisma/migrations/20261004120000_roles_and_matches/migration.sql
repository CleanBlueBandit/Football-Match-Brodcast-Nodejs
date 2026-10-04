-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'broadcaster', 'statistician', 'viewer');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('scheduled', 'live', 'finished');

-- AlterTable: new accounts default to the least-privileged role...
ALTER TABLE "users" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'viewer';

-- ...but every account that exists before this migration was a full-access
-- account (there were no roles), so keep them as admins and nobody is locked out.
UPDATE "users" SET "role" = 'admin';

-- CreateTable
CREATE TABLE "matches" (
    "id" SERIAL NOT NULL,
    "home_team_id" VARCHAR(64) NOT NULL,
    "away_team_id" VARCHAR(64) NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'scheduled',
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "home_score" INTEGER NOT NULL DEFAULT 0,
    "away_score" INTEGER NOT NULL DEFAULT 0,
    "home_fouls" INTEGER NOT NULL DEFAULT 0,
    "away_fouls" INTEGER NOT NULL DEFAULT 0,
    "home_possession" INTEGER NOT NULL DEFAULT 50,
    "away_possession" INTEGER NOT NULL DEFAULT 50,
    "counts_in_league" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_player_stats" (
    "id" SERIAL NOT NULL,
    "match_id" INTEGER NOT NULL,
    "team_id" VARCHAR(64) NOT NULL,
    "number" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "goals" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "fouls" INTEGER NOT NULL DEFAULT 0,
    "yellow_cards" INTEGER NOT NULL DEFAULT 0,
    "red_cards" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "match_player_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "matches_status_idx" ON "matches"("status");

-- CreateIndex
CREATE UNIQUE INDEX "match_player_stats_match_id_team_id_number_key" ON "match_player_stats"("match_id", "team_id", "number");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_home_team_id_fkey" FOREIGN KEY ("home_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_away_team_id_fkey" FOREIGN KEY ("away_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_player_stats" ADD CONSTRAINT "match_player_stats_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
