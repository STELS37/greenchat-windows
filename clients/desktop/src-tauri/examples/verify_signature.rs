use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let artifact = args.next().ok_or("artifact path is required")?;
    let signature = args.next().ok_or("signature path is required")?;
    let public_key = args.next().ok_or("public key path is required")?;
    if args.next().is_some() {
        return Err("unexpected extra arguments".into());
    }

    let key = PublicKey::from_file(Path::new(&public_key))?;
    let signature = Signature::from_file(Path::new(&signature))?;
    let mut verifier = key.verify_stream(&signature)?;
    let mut file = File::open(&artifact)?;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier.finalize()?;

    let name = Path::new(&artifact)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact");
    writeln_stdout(&format!("MINISIGN-VERIFY: OK {name}"))?;
    Ok(())
}

fn writeln_stdout(message: &str) -> io::Result<()> {
    use std::io::Write;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{message}")
}
