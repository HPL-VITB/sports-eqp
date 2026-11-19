// Lets code written as `React.FormEvent` type-check against the stand-in.
declare namespace React {
  type ReactNode = import("./react").ReactNode;
  type FormEvent<T = Element> = import("./react").FormEvent<T>;
  type ChangeEvent<T = Element> = import("./react").ChangeEvent<T>;
}
declare module "*.css";
declare module "pg" { namespace pg { type Pool = any; type PoolClient = any; } const pg: any; export default pg; }
declare module "nodemailer" { namespace nodemailer { type Transporter = any; } const nodemailer: any; export default nodemailer; }
