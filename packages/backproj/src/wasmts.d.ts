declare module '@wcohen/wasmts' {
  interface Coordinate {
    x: number;
    y: number;
    z?: number;
    m?: number;
  }

  interface CoordinateSequence {
    getX(i: number): number;
    getY(i: number): number;
    getZ(i: number): number;
    getM(i: number): number;
    getOrdinate(i: number, ordinateIndex: number): number;
    setOrdinate(i: number, ordinateIndex: number, value: number): void;
    size(): number;
    getDimension(): number;
    hasZ(): boolean;
    hasM(): boolean;
    getCoordinate(i: number): Coordinate;
    toCoordinateArray(): Coordinate[];
    copy(): CoordinateSequence;
  }

  interface Geometry {
    getArea(): number;
    getLength(): number;
    getCoordinates(): Coordinate[];
    getCoordinate(): Coordinate | null;
    isValid(): boolean;
    isEmpty(): boolean;
    getNumGeometries(): number;
    getGeometryN(n: number): Geometry;
    buffer(distance: number): Geometry;
    union(other: Geometry): Geometry;
    intersection(other: Geometry): Geometry;
    difference(other: Geometry): Geometry;
    contains(other: Geometry): boolean;
    intersects(other: Geometry): boolean;
    apply(filterFn: (seq: CoordinateSequence, i: number) => void): Geometry;
    applyCoordinates(flatArray: ArrayLike<number>, valuesPerCoord: number): Geometry;
    getExteriorRing(): Geometry;
    getNumInteriorRing(): number;
    getInteriorRingN(n: number): Geometry;
    getCoordinateSequence(): CoordinateSequence;
    getDimension(): number;
    type: string;
  }

  interface Envelope {
    getMinX(): number;
    getMaxX(): number;
    getMinY(): number;
    getMaxY(): number;
    getWidth(): number;
    getHeight(): number;
    getArea(): number;
    isNull(): boolean;
    expandBy(distance: number): void;
    expandBy(deltaX: number, deltaY: number): void;
    copy(): Envelope;
  }

  interface PrecisionModelInstance {
    getType(): string;
    getScale(): number;
    isFloating(): boolean;
    makePrecise(value: number): number;
    gridSize(): number;
  }

  namespace geom {
    function createPoint(x: number, y: number, z?: number, m?: number): Geometry;
    function createLineString(coords: Coordinate[]): Geometry;
    function createPolygon(shell: Coordinate[], holes?: Coordinate[][]): Geometry;
    function createLinearRing(coords: Coordinate[]): Geometry;
    function createMultiPoint(points: Geometry[]): Geometry;
    function createMultiLineString(lines: Geometry[]): Geometry;
    function createMultiPolygon(polys: Geometry[]): Geometry;
    function createGeometryCollection(geoms: Geometry[]): Geometry;
    function createEnvelope(minX: number, maxX: number, minY: number, maxY: number): Envelope;
    function createEmpty(dimension: number): Geometry;
    function toGeometry(envelope: Envelope): Geometry;

    function union(geom1: Geometry, geom2: Geometry): Geometry;
    function intersection(geom1: Geometry, geom2: Geometry): Geometry;
    function difference(geom1: Geometry, geom2: Geometry): Geometry;
    function buffer(geom: Geometry, distance: number): Geometry;
    function simplify(geom: Geometry, tolerance: number): Geometry;
    function convexHull(geom: Geometry): Geometry;
    function copy(geom: Geometry): Geometry;

    function contains(geom1: Geometry, geom2: Geometry): boolean;
    function intersects(geom1: Geometry, geom2: Geometry): boolean;
    function isValid(geom: Geometry): boolean;
    function isEmpty(geom: Geometry): boolean;
    function getArea(geom: Geometry): number;
    function getLength(geom: Geometry): number;
    function getNumPoints(geom: Geometry): number;
    function getCoordinates(geom: Geometry): Coordinate[];
    function getNumGeometries(geom: Geometry): number;
    function getGeometryN(geom: Geometry, n: number): Geometry;
    function getEnvelopeInternal(geom: Geometry): Envelope;
    function apply(geom: Geometry, filterFn: (seq: CoordinateSequence, i: number) => void): Geometry;
    function applyCoordinates(geom: Geometry, flatArray: ArrayLike<number>, valuesPerCoord: number): Geometry;

    namespace PrecisionModel {
      function create(): PrecisionModelInstance;
      function create(typeOrScale: string | number): PrecisionModelInstance;
      function createFixed(scale: number): PrecisionModelInstance;
    }

    namespace util {
      namespace GeometryFixer {
        function fix(geom: Geometry, isKeepMulti?: boolean): Geometry;
        function create(geom: Geometry): any;
        function setKeepCollapsed(fixer: any, val: boolean): void;
        function setKeepMulti(fixer: any, val: boolean): void;
        function getResult(fixer: any): Geometry;
      }
    }
  }

  namespace io {
    namespace GeoJSONReader {
      function read(geojsonString: string): Geometry;
      function create(): { read(geojsonString: string): Geometry };
    }
    namespace GeoJSONWriter {
      function write(geom: Geometry): string;
      function create(): { write(geom: Geometry): string; setForceCCW(val: boolean): void; setEncodeCRS(val: boolean): void };
      function createWithDecimals(n: number): { write(geom: Geometry): string };
    }
    namespace WKTReader {
      function read(wkt: string): Geometry;
    }
    namespace WKTWriter {
      function write(geom: Geometry): string;
    }
  }

  namespace densify {
    namespace Densifier {
      function densify(geom: Geometry, tolerance: number): Geometry;
      function create(geom: Geometry): any;
      function setDistanceTolerance(d: any, tolerance: number): void;
      function setValidate(d: any, isValidated: boolean): void;
      function getResultGeometry(d: any): Geometry;
    }
  }

  namespace coverage {
    namespace CoverageUnion {
      function union(geoms: Geometry[]): Geometry;
    }
  }

  namespace precision {
    namespace GeometryPrecisionReducer {
      function reduce(geom: Geometry, pm: PrecisionModelInstance): Geometry;
      function reduceKeepCollapsed(geom: Geometry, pm: PrecisionModelInstance): Geometry;
      function reducePointwise(geom: Geometry, pm: PrecisionModelInstance): Geometry;
      function create(pm: PrecisionModelInstance): any;
      function setChangePrecisionModel(r: any, val: boolean): void;
      function setRemoveCollapsedComponents(r: any, val: boolean): void;
      function reduceInstance(r: any, geom: Geometry): Geometry;
    }
  }

  namespace operation {
    namespace union {
      namespace CascadedPolygonUnion {
        function union(polygons: Geometry[]): Geometry;
      }
    }
  }
}
