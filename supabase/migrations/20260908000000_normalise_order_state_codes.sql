-- =====================================================================
-- Normalise orders.state to two-letter codes
-- =====================================================================
-- Everything keyed on state uses the two-letter code: regionOf(), STATE_ORDERS,
-- the coverage map, and the by-state report. The Place Order wizard kept its own
-- list of full state NAMES and used the name as the option value, so every order
-- a client placed stored "Florida" while every other order stored "FL".
--
-- The consequences were all silent: the by-state report counted FL and Florida as
-- two separate states, regionOf("Florida") was undefined so those orders fell
-- outside every region filter and rendered "—", and the coverage map (keyed on
-- abbreviations) could never match them at all.
--
-- The wizard now writes the code. This backfills the rows written before that,
-- so historic orders group with the rest instead of splitting the totals.
-- Idempotent: rows already holding a code are left alone.
-- =====================================================================

update public.orders o
set state = m.code
from (values
  ('Alabama','AL'),('Alaska','AK'),('Arizona','AZ'),('Arkansas','AR'),('California','CA'),
  ('Colorado','CO'),('Connecticut','CT'),('Delaware','DE'),('District of Columbia','DC'),
  ('Florida','FL'),('Georgia','GA'),('Hawaii','HI'),('Idaho','ID'),('Illinois','IL'),
  ('Indiana','IN'),('Iowa','IA'),('Kansas','KS'),('Kentucky','KY'),('Louisiana','LA'),
  ('Maine','ME'),('Maryland','MD'),('Massachusetts','MA'),('Michigan','MI'),('Minnesota','MN'),
  ('Mississippi','MS'),('Missouri','MO'),('Montana','MT'),('Nebraska','NE'),('Nevada','NV'),
  ('New Hampshire','NH'),('New Jersey','NJ'),('New Mexico','NM'),('New York','NY'),
  ('North Carolina','NC'),('North Dakota','ND'),('Ohio','OH'),('Oklahoma','OK'),('Oregon','OR'),
  ('Pennsylvania','PA'),('Rhode Island','RI'),('South Carolina','SC'),('South Dakota','SD'),
  ('Tennessee','TN'),('Texas','TX'),('Utah','UT'),('Vermont','VT'),('Virginia','VA'),
  ('Washington','WA'),('West Virginia','WV'),('Wisconsin','WI'),('Wyoming','WY')
) as m(name, code)
where lower(btrim(o.state)) = lower(m.name);
