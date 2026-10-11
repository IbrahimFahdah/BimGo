using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using BimGo.Format;
using BimGo.Scene;
using Microsoft.VisualStudio.TestTools.UnitTesting;

// The class belongs to the Tests namespace
namespace BimGo.Tests
{
    /// <summary>
    /// Tour round, build A2: the location override (place search, typed coordinates, the effective site, daylight
    /// saving from the zone).
    /// </summary>
    [TestClass]
    public sealed class LocationTests
    {
        private const string LIST =
            "# comment line\n" +
            "Sydney\tNew South Wales\tAustralia\t-33.9181\t151.1832\tAustralia/Sydney\t4630000\n" +
            "Sydney\tNova Scotia\tCanada\t46.0661\t-60.1800\tAmerica/Halifax\t37538\n" +
            "Perth\tWestern Australia\tAustralia\t-31.9531\t115.8381\tAustralia/Perth\t1532000\n" +
            "Perth\tPerthshire and Kinross\tUnited Kingdom\t56.4003\t-3.4700\tEurope/London\t39654\n" +
            "São Paulo\tSão Paulo\tBrazil\t-23.5567\t-46.6270\tAmerica/Sao_Paulo\t18845000\n" +
            "São Carlos\tSão Paulo\tBrazil\t-22.0200\t-47.8900\tAmerica/Sao_Paulo\t200000\n" +
            "Broken line without enough fields\n" +
            "Nowhere\tX\tY\t123.0\t0.0\t\t1\n";

        private static PlaceIndex Index() => PlaceIndex.Load(new StringReader(LIST));

        [TestMethod]
        public void Load_SkipsCommentsAndBadLines()
        {
            Assert.AreEqual(6, Index().Count, "the comment, the short line and the out-of-range latitude are skipped");
        }

        [TestMethod]
        public void Search_RanksNamesThenPopulation()
        {
            var results = new List<Place>();
            PlaceIndex index = Index();

            index.Search("sydney", results);
            Assert.AreEqual(2, results.Count);
            Assert.AreEqual("Australia", results[0].Country, "the bigger Sydney first");
            Assert.AreEqual("Sydney, New South Wales, Australia", results[0].Label);

            index.Search("perth united", results);
            Assert.AreEqual(1, results.Count, "every word must match");
            Assert.AreEqual("United Kingdom", results[0].Country);

            index.Search("sao paulo", results);
            Assert.AreEqual("São Paulo", results[0].Name, "accents are ignored; the exact name wins");
            Assert.AreEqual("São Paulo, Brazil", results[0].Label, "the region is left out when it repeats the name");
            Assert.AreEqual(2, results.Count, "São Carlos is in São Paulo state");

            index.Search("  ", results);
            Assert.AreEqual(0, results.Count);
            index.Search("syd", results, max: 1);
            Assert.AreEqual(1, results.Count);
        }

        [TestMethod]
        public void Coordinates_DecimalHemispheresAndDegreesMinutes()
        {
            Assert.IsTrue(PlaceIndex.TryParseCoordinates("-33.8688, 151.2093", out double lat, out double lon));
            Assert.AreEqual(-33.8688, lat, 1e-9);
            Assert.AreEqual(151.2093, lon, 1e-9);

            Assert.IsTrue(PlaceIndex.TryParseCoordinates("-33.8688 151.2093", out lat, out lon), "a space works too");
            Assert.AreEqual(151.2093, lon, 1e-9);

            Assert.IsTrue(PlaceIndex.TryParseCoordinates("33.8688S 151.2093E", out lat, out lon));
            Assert.AreEqual(-33.8688, lat, 1e-9);

            Assert.IsTrue(PlaceIndex.TryParseCoordinates("51°30′N, 0°7′W", out lat, out lon));
            Assert.AreEqual(51.5, lat, 1e-9);
            Assert.AreEqual(-7.0 / 60.0, lon, 1e-9);

            Assert.IsFalse(PlaceIndex.TryParseCoordinates("sydney", out _, out _));
            Assert.IsFalse(PlaceIndex.TryParseCoordinates("95, 10", out _, out _), "latitude out of range");
            Assert.IsFalse(PlaceIndex.TryParseCoordinates("10, 200", out _, out _), "longitude out of range");
        }

        [TestMethod]
        public void Nearest_FindsThePlaceWithinTheLimit()
        {
            PlaceIndex index = Index();
            Place near = index.Nearest(-33.80, 151.00, 300, out double km);
            Assert.IsNotNull(near);
            Assert.AreEqual("Australia/Sydney", near.ZoneId);
            Assert.IsTrue(km > 10 && km < 30, $"{km} km");
            Assert.IsNull(index.Nearest(0, 0, 300, out _), "nothing within 300 km of 0°, 0°");
            Assert.AreEqual(0.0, PlaceIndex.DistanceKm(10, 20, 10, 20), 1e-9);
            Assert.AreEqual(111.19, PlaceIndex.DistanceKm(0, 0, 1, 0), 0.05, "one degree of latitude");
        }

        [TestMethod]
        public void Fold_LowersAndStripsAccents()
        {
            Assert.AreEqual("sao paulo", PlaceIndex.Fold("São  Paulo"));
            Assert.AreEqual("lodz", PlaceIndex.Fold("Łódź"));
        }

        [TestMethod]
        public void EffectiveSite_ReplacesTheLocationOnlyOnACopy()
        {
            var site = new SiteInfo { HasLocation = true, Latitude = 51.5, Longitude = -0.12, TimeZone = 0, PlaceName = "London", TrueNorthAngle = 0.3f };
            var location = new LocationOverride { Latitude = -33.87, Longitude = 151.21, TimeZone = 10, ZoneId = "Australia/Sydney", Name = "Sydney" };

            SiteInfo effective = SolarPosition.EffectiveSite(site, location);
            Assert.AreNotSame(site, effective);
            Assert.AreEqual(-33.87, effective.Latitude);
            Assert.AreEqual("Sydney", effective.PlaceName);
            Assert.AreEqual("Australia/Sydney", effective.ZoneId);
            Assert.IsTrue(effective.AutoDaylightSaving);
            Assert.AreEqual(0.3f, effective.TrueNorthAngle, "true north stays the model's");
            Assert.AreEqual(51.5, site.Latitude, "the model's site is untouched");

            Assert.AreSame(site, SolarPosition.EffectiveSite(site, null));
            Assert.AreSame(site, SolarPosition.EffectiveSite(site, new LocationOverride { Latitude = 99 }), "an invalid override is ignored");

            // The zone never reaches model.json
            string json = JsonSerializer.Serialize(effective);
            Assert.IsFalse(json.Contains("ZoneId"), json);
        }

        [TestMethod]
        public void DaylightSaving_ManualWithoutAZoneAutoWithOne()
        {
            var noZone = new GeoLocation(-33.87, 151.21, 10, "Sydney");
            Assert.IsTrue(SolarPosition.IsDaylightSaving(noZone, 2026, 1, 15, manual: true), "no zone: the tick decides");
            Assert.IsFalse(SolarPosition.IsDaylightSaving(noZone, 2026, 1, 15, manual: false));

            var unknown = new GeoLocation(0, 0, 0, "X") { ZoneId = "Not/AZone", AutoDaylightSaving = true };
            Assert.IsTrue(SolarPosition.IsDaylightSaving(unknown, 2026, 1, 15, manual: true), "an unknown zone falls back to the tick");

            if (!TimeZones.TryFind("Australia/Sydney", out _))
            {
                Assert.Inconclusive("This machine can't resolve IANA zones (no ICU / no mapping): auto daylight saving can't be checked here.");
            }
            var sydney = new GeoLocation(-33.87, 151.21, 10, "Sydney") { ZoneId = "Australia/Sydney", AutoDaylightSaving = true };
            Assert.IsTrue(SolarPosition.IsDaylightSaving(sydney, 2026, 1, 15, manual: false), "Sydney is on DST in January");
            Assert.IsFalse(SolarPosition.IsDaylightSaving(sydney, 2026, 6, 15, manual: true), "and off in June, whatever the tick");
            Assert.AreEqual(10.0, TimeZones.StandardOffset("Australia/Sydney", 151.21), 1e-9);

            // Compute applies it: January noon with auto = the same sun as a manual +1 h
            SolarPosition.Compute(sydney, 2026, 1, 15, 720, false, out double autoAlt, out double autoAz);
            SolarPosition.Compute(noZone, 2026, 1, 15, 720, true, out double manualAlt, out double manualAz);
            Assert.AreEqual(manualAlt, autoAlt, 1e-12);
            Assert.AreEqual(manualAz, autoAz, 1e-12);
        }

        [TestMethod]
        public void StandardOffset_EstimatesFromLongitudeWithoutAZone()
        {
            Assert.AreEqual(10.0, TimeZones.StandardOffset(null, 151.2));
            Assert.AreEqual(-5.0, TimeZones.EstimateOffset(-74.0));
            Assert.AreEqual(0.0, TimeZones.EstimateOffset(double.NaN));
        }

        [TestMethod]
        public void SunSettings_KeepsAValidOverrideAndDropsABadOne()
        {
            var sun = new SunSettings { Location = new LocationOverride { Latitude = 40.7, Longitude = -74, TimeZone = -5, ZoneId = " America/New_York ", Name = "New York" } }.Clean();
            Assert.IsNotNull(sun.Location);
            Assert.AreEqual("America/New_York", sun.Location.ZoneId, "trimmed");
            Assert.AreEqual(40.7, sun.Copy().Location.Latitude, "copied");
            Assert.AreNotSame(sun.Location, sun.Copy().Location);

            var bad = new SunSettings { Location = new LocationOverride { Latitude = double.NaN } }.Clean();
            Assert.IsNull(bad.Location);
        }

        [TestMethod]
        public void SunDirections_FollowTheOverride()
        {
            var settings = new SunHoursSettings { Month = 6, Day = 21, StartMinutes = 5 * 60, EndMinutes = 21 * 60, StepMinutes = 15 };
            var london = new SiteInfo { HasLocation = true, Latitude = 51.5, Longitude = -0.12, TimeZone = 0 };
            var sydney = SolarPosition.EffectiveSite(london, new LocationOverride { Latitude = -33.87, Longitude = 151.21, TimeZone = 10, Name = "Sydney" });
            int year = DateTime.Today.Year;
            List<System.Numerics.Vector3> north = SunHours.SunDirections(london, year, settings, out _, out bool knownNorth);
            List<System.Numerics.Vector3> south = SunHours.SunDirections(sydney, year, settings, out _, out bool knownSouth);
            Assert.IsTrue(knownNorth && knownSouth);
            Assert.IsTrue(north.Count > south.Count, "June: more sun samples above the horizon in London than in Sydney");
        }
    }
}
