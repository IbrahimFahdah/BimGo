// System specific
global using System.IO;

// Autodesk specific
global using Autodesk.Revit.DB;
global using Autodesk.Revit.UI;
global using Autodesk.Revit.Attributes;
global using DB = Autodesk.Revit.DB;
global using UI = Autodesk.Revit.UI;

// Addin specific
global using RvtGo.Extensions;
global using RvtGo.Forms;
global using UtilDat = RvtGo.Utilities.Data_Utils;
global using UtilRib = RvtGo.Utilities.Ribbon_Utils;

// Disambiguation (RvtGo types that share a name with Revit API / framework types)
global using ElementRecord = RvtGo.Scene.ElementRecord;
