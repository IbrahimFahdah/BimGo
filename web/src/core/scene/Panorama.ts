import { type Vec3, vec3 } from '../math/Vector';

/**
 * 360° panoramas (port of BimGo.Core/Scene/Panorama.cs): the equirectangular mapping and the Google Photo Sphere
 * (GPano) XMP that makes phones, Facebook and panorama viewers open a JPEG as a 360 photo. Pure functions.
 */
export const Panorama = {
  /**
   * The view direction (scene axes, Z up) of an equirectangular pixel's centre. The middle column looks along
   * headingYaw (radians, as the player's yaw); columns to the right turn right; the top row looks straight up.
   */
  direction(column: number, row: number, width: number, height: number, headingYaw: number): Vec3 {
    const longitude = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
    const latitude = (0.5 - (row + 0.5) / height) * Math.PI;
    const yaw = headingYaw - longitude;
    const c = Math.cos(latitude);
    return vec3(c * Math.cos(yaw), c * Math.sin(yaw), Math.sin(latitude));
  },

  /** The square face size (px) matching an equirectangular width at the face centre: 2·tan(fov / 2) · width / 2π. */
  faceSize(panoramaWidth: number, faceFovDegrees: number): number {
    const half = faceFovDegrees * Math.PI / 360;
    return Math.max(16, Math.ceil(2 * Math.tan(half) * panoramaWidth / (2 * Math.PI)));
  },

  /**
   * A JPEG with a GPano XMP segment (APP1) added after the JFIF header: equirectangular, full panorama, the given
   * heading (degrees, or null). Returns the input unchanged when it isn't a JPEG.
   */
  addPhotoSphereXmp(jpeg: Uint8Array, width: number, height: number, headingDegrees: number | null = null): Uint8Array {
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) { return jpeg; }
    const heading = headingDegrees !== null
      ? `<GPano:PoseHeadingDegrees>${(((headingDegrees % 360) + 360) % 360).toFixed(1)}</GPano:PoseHeadingDegrees>`
      : '';
    const xmp =
      '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/">' +
      '<GPano:ProjectionType>equirectangular</GPano:ProjectionType>' +
      '<GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>' +
      `<GPano:CroppedAreaImageWidthPixels>${width}</GPano:CroppedAreaImageWidthPixels>` +
      `<GPano:CroppedAreaImageHeightPixels>${height}</GPano:CroppedAreaImageHeightPixels>` +
      `<GPano:FullPanoWidthPixels>${width}</GPano:FullPanoWidthPixels>` +
      `<GPano:FullPanoHeightPixels>${height}</GPano:FullPanoHeightPixels>` +
      '<GPano:CroppedAreaLeftPixels>0</GPano:CroppedAreaLeftPixels>' +
      '<GPano:CroppedAreaTopPixels>0</GPano:CroppedAreaTopPixels>' +
      heading +
      '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

    const encoder = new TextEncoder();
    const header = encoder.encode('http://ns.adobe.com/xap/1.0/\0');
    const body = encoder.encode(xmp);
    const length = 2 + header.length + body.length;
    if (length > 0xffff) { return jpeg; }

    // After SOI, and after a JFIF APP0 segment when there is one (some readers want JFIF first)
    let insertAt = 2;
    if (jpeg.length > 6 && jpeg[2] === 0xff && jpeg[3] === 0xe0) {
      const app0 = (jpeg[4] << 8) | jpeg[5];
      if (4 + app0 <= jpeg.length) { insertAt = 4 + app0; }
    }

    const output = new Uint8Array(jpeg.length + 2 + length);
    output.set(jpeg.subarray(0, insertAt), 0);
    let o = insertAt;
    output[o++] = 0xff;
    output[o++] = 0xe1;
    output[o++] = (length >> 8) & 0xff;
    output[o++] = length & 0xff;
    output.set(header, o);
    o += header.length;
    output.set(body, o);
    o += body.length;
    output.set(jpeg.subarray(insertAt), o);
    return output;
  }
};
