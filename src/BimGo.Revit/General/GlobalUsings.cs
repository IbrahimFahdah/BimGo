// System specific
global using System.IO;

// Autodesk specific
global using Autodesk.Revit.DB;
global using Autodesk.Revit.UI;
global using Autodesk.Revit.Attributes;
global using DB = Autodesk.Revit.DB;
global using UI = Autodesk.Revit.UI;

// Addin specific
global using BimGo.Extensions;
global using BimGo.Forms;
global using UtilDat = BimGo.Utilities.Data_Utils;
global using UtilRib = BimGo.Utilities.Ribbon_Utils;

// Disambiguation (BimGo types that share a name with Revit API / framework types)
global using ElementRecord = BimGo.Scene.ElementRecord;
