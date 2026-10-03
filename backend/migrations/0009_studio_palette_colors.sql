-- Decision D-6 (Studio redesign, ADR-0010): the collaborator palette changes from the v1.1 set to the Studio set.
-- Registration stores USER_PALETTE[fnv1a32(id) mod 12], so a stored colour is really a palette slot. Remapping slot i
-- of the v1.1 set to slot i of the Studio set keeps every user on the slot the hash gives them, so stored colours and
-- colours derived for new registrations agree on both sides of this migration, and the reverse section is the exact
-- inverse. Notes:
--   * the two sets are disjoint, so each row matches at most one pair and the UPDATE never chains;
--   * a colour outside the source set is not a slot this migration knows and is left unchanged;
--   * updated_at is not touched: a palette swap is not an edit of the user, and it lets the reverse restore rows exactly;
--   * every written value is lowercase #rrggbb, so users_color_ck stays valid.

-- Up Migration
UPDATE users AS u
SET color = p.studio
FROM (VALUES
  ('#a95208', '#b4f500'), --  1 tangerine  -> lime
  ('#6c4b01', '#f461ff'), --  2 ochre      -> orchid
  ('#35552a', '#ffab61'), --  3 moss       -> tangerine
  ('#0e7c24', '#b86e3d'), --  4 leaf       -> copper
  ('#15735c', '#bcfab2'), --  5 pine       -> mint
  ('#2f747e', '#a64ef4'), --  6 teal       -> violet
  ('#156eb0', '#9888d7'), --  7 ocean      -> periwinkle
  ('#641b84', '#ff8fcb'), --  8 grape      -> pink
  ('#ad38a0', '#f6dd79'), --  9 orchid     -> gold
  ('#7e1750', '#447ec1'), -- 10 plum       -> cobalt
  ('#c02c52', '#c44f9d'), -- 11 rose       -> plum
  ('#572a0e', '#5eae29')  -- 12 cocoa      -> grass
) AS p (v1, studio)
WHERE u.color = p.v1;

-- Down Migration
UPDATE users AS u
SET color = p.v1
FROM (VALUES
  ('#a95208', '#b4f500'),
  ('#6c4b01', '#f461ff'),
  ('#35552a', '#ffab61'),
  ('#0e7c24', '#b86e3d'),
  ('#15735c', '#bcfab2'),
  ('#2f747e', '#a64ef4'),
  ('#156eb0', '#9888d7'),
  ('#641b84', '#ff8fcb'),
  ('#ad38a0', '#f6dd79'),
  ('#7e1750', '#447ec1'),
  ('#c02c52', '#c44f9d'),
  ('#572a0e', '#5eae29')
) AS p (v1, studio)
WHERE u.color = p.studio;
